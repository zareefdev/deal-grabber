const http = require('node:http');
const { createHash } = require('node:crypto');
const { readFile, writeFile } = require('node:fs/promises');
const { existsSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.PORT || 4173);
const refreshMs = Number(process.env.REFRESH_MS || 10 * 60 * 1000);
const cacheFile = path.join(__dirname, 'public', 'deals.json');
// public/deals.json is the artefact that gets deployed; this private sidecar keeps
// the merge ledger alive between runs. It is gitignored locally and restored from
// the Actions cache in CI, so a fresh checkout still knows what it saw last time.
const stateFile = path.join(__dirname, '.deal-state.json');

// Unseen deals survive a merge for this long before being expired for good. A
// scrape that returns fewer rows than last time never deletes the difference
// outright, so this TTL is the only clock that removes a listing.
const DEAL_TTL_MS = Number(process.env.DEAL_TTL_MS || 24 * 60 * 60 * 1000);
// A fully blocked store may hold its last snapshot for at most this long.
const STORE_STALE_MS = Number(process.env.STORE_STALE_MS || 3 * 60 * 60 * 1000);
const MAX_STORE_DEALS = Number(process.env.MAX_STORE_DEALS || 600);
// The published feed holds at most this many deals in total, split 70/30 across
// stores, and every listing must clear this price floor. Rows that are stale
// (carried over, not seen this run) or out of stock are dropped outright.
const MAX_DEALS = Number(process.env.MAX_DEALS || 500);
const MIN_DEAL_PRICE = Number(process.env.MIN_DEAL_PRICE || 1000);
// Amazon's slice of MAX_DEALS; the remainder is Flipkart's. Mirrors the client mix.
const AMAZON_SHARE = 0.7;
// Amazon Associates tracking id. Appended to every Amazon link we emit so the
// click is attributed and the site earns the referral commission.
const AMAZON_TAG = process.env.AMAZON_TAG || 'mdzareef-21';
const amazonUrl = asin => `https://www.amazon.in/dp/${asin}?tag=${encodeURIComponent(AMAZON_TAG)}`;

// Optional outbound proxy for the whole scraping browser. On datacenter IPs the
// stores intermittently answer with a robot interstitial (no result cards), which
// is the only reason a CI run scrapes less than a local one. Pointing the browser
// at a residential proxy removes that class of failure entirely. Accepts the
// usual http(s)://user:pass@host:port and socks5:// URLs; unset means direct.
const SCRAPE_PROXY = process.env.SCRAPE_PROXY || '';

let cache;
let cachedAt = 0;
let inflight = null;

// Restore the last good scrape so a restart cannot regress the page to one store
// while Flipkart is transiently blocked. There are two candidates: the private
// sidecar, which is rewritten on every scrape, and the committed public/deals.json,
// which in CI is the rich snapshot captured on a residential IP. Take whichever
// holds more of each store, so the committed floor is never shadowed by a smaller
// ledger the runner accumulated.
const restoredSnapshots = [];
for (const file of [stateFile, cacheFile]) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && parsed.amazon && parsed.flipkart) restoredSnapshots.push(parsed);
  } catch {}
}
if (restoredSnapshots.length) {
  const richerStore = key => restoredSnapshots.reduce((best, snap) =>
    ((snap[key].deals || []).length > (best[key].deals || []).length ? snap : best), restoredSnapshots[0]);
  cache = {
    ...restoredSnapshots[0],
    amazon: richerStore('amazon').amazon,
    flipkart: richerStore('flipkart').flipkart
  };
  // A restored snapshot can predate these rules, so strip stale/out-of-stock and
  // sub-₹1000 rows here too — the first response is already clean.
  const amazonBudget = Math.round(MAX_DEALS * AMAZON_SHARE);
  cache.amazon = { ...cache.amazon, deals: finaliseStoreDeals(cache.amazon.deals, amazonBudget) };
  cache.flipkart = { ...cache.flipkart, deals: finaliseStoreDeals(cache.flipkart.deals, MAX_DEALS - amazonBudget) };
  cache.amazon.total = cache.amazon.deals.length;
  cache.flipkart.total = cache.flipkart.deals.length;
  cache.total = cache.amazon.total + cache.flipkart.total;
  cachedAt = Math.max(...restoredSnapshots.map(snap => Date.parse(snap.updatedAt) || 0));
}

function readJsonObjectAt(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (!depth) return text.slice(start, i + 1); }
  }
  return null;
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

// ── Flipkart parser (parses embedded JSON state instead of CSS-hashed markup) ──
function extractInitialState(html) {
  const m = html.match(/(?:window\.)?__(?:INITIAL|PRELOADED)_STATE__\s*=\s*(\{)/);
  if (!m) return null;
  const s = html.slice(m.index + m[0].length - 1);
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (!depth) { end = i; break; } }
  }
  if (end < 0) return null;
  try { return JSON.parse(s.slice(0, end + 1)); } catch { return null; }
}

function collectFlipkartProducts(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const v of node) collectFlipkartProducts(v, out); return; }
  // Modern search pages wrap the product as { productInfo: { value: {...} } };
  // older/other payloads hang the product straight off productBaseInfoV1.
  const info = node.productBaseInfoV1 || (node.productInfo && node.productInfo.value) || node;
  // Real cards expose the link as a relative `baseUrl` (/slug/p/itm…?pid=…); other
  // shapes (rating/review widgets) carry itemId + productId but no link at all.
  const rawUrl = String(info.productUrl || info.baseUrl || node.productUrl || node.baseUrl || '');
  const itemFromUrl = (rawUrl.match(/\/p\/(itm[0-9a-f]+)/i) || [])[1] || '';
  // Newer payloads carry node.productId as a non-ITM SKU (e.g. COMHCPHGZXJWVNX2) which
  // would shadow the real itemId; prefer whichever candidate is ITM-shaped, then the
  // ITM id embedded in the product URL.
  const pid = [node.itemId, info.itemId, node.productId, node.baseProductId]
    .find(v => typeof v === 'string' && /^ITM/i.test(v)) || itemFromUrl;
  const productId = String(info.productId || node.productId || '');
  // A bare "https://www.flipkart.com" link is useless, so when the payload carries no
  // explicit URL, rebuild the short form from both ids: /product/p/<itemId>?pid=<pid>.
  const url = rawUrl || (pid && productId ? `https://www.flipkart.com/product/p/${pid}?pid=${productId}` : '');
  if (pid && url) {
    const pay = Number(info.flipkartSpecialPrice?.value ?? info.pricing?.finalPrice?.value ?? info.finalPrice?.value ?? 0);
    const mrp = Number(info.maximumRetailPrice?.value ?? info.pricing?.mrp?.value ?? 0);
    const title = (info.titles && info.titles.title) || info.title || node.title || '';
    const urls = info.imageUrls || {};
    const media = ((info.media && info.media.images) || [])[0] || {};
    const image = String(urls['400x400'] || urls['200x200'] || media.url || info.imageUrl || '')
      .replace('{@width}', '400').replace('{@height}', '400').replace('{@quality}', '90')
      .replace(/^http:/, 'https:');
    if (pay > 0 && title) out.push({
      id: pid, title,
      url,
      image,
      pay, mrp: mrp > pay ? mrp : 0,
      available: stockAvailable(info.availability ?? info.availabilityStatus ?? node.availability),
      discount: Number(info.discountPercentage?.value || (mrp > pay ? Math.round(((mrp - pay) / mrp) * 100) : 0))
    });
  }
  for (const k in node) collectFlipkartProducts(node[k], out);
}

// Reads whatever availability signal a source exposes (a boolean, or an object
// like {type:'OUT_OF_STOCK'} / {value:'IN_STOCK'}) and reports whether the item
// is buyable. Absent signal means in stock — the default for the page scrapers,
// which only ever surface cards the store is currently showing.
function stockAvailable(raw) {
  if (raw === false) return false;
  if (raw === true || raw == null) return true;
  const s = String(typeof raw === 'object' ? (raw.value ?? raw.status ?? raw.type ?? '') : raw);
  if (!s) return true;
  return !/OUT.?OF.?STOCK|UNAVAILABLE|NOT.?AVAILABLE|DISCONTINUED|SOLD.?OUT|NO_?LONGER/i.test(s);
}

// Shared normalisation: turns raw collector hits into the public deal shape.
// Used by both the plain-HTML parser and the rendered-browser path so both emit
// identical objects (id `fk-<pid>`, store 'Flipkart', inr() prices, <5% dropped).
function normalizeFlipkartDeals(found, category) {
  const seen = new Set(), out = [];
  const inr = n => `₹${Math.round(n).toLocaleString('en-IN')}`;
  for (const p of found) {
    // Item ids arrive uppercase from the embedded state and lowercase from the DOM,
    // so dedupe case-insensitively to avoid the same product twice. A card with no
    // resolvable URL is dropped rather than linking to the Flipkart homepage.
    const key = String(p.id).toLowerCase();
    if (!p.url || seen.has(key) || p.discount < 5) continue;
    seen.add(key);
    out.push({
      id: `fk-${p.id}`, store: 'Flipkart', title: decodeHtml(p.title),
      image: p.image,
      url: p.url.startsWith('http') ? p.url : `https://www.flipkart.com${p.url}`,
      price: inr(p.pay), originalPrice: p.mrp ? inr(p.mrp) : '',
      discount: Math.round(p.discount), available: p.available !== false, category
    });
  }
  return out;
}

function parseFlipkart(html, category) {
  const state = extractInitialState(html);
  if (!state) return [];
  const found = [];
  collectFlipkartProducts(state, found);
  return normalizeFlipkartDeals(found, category);
}

// ── Rendered Flipkart (Playwright) ───────────────────────────────
// Plain fetch now receives an Akamai client-rendered skeleton. A real browser is
// required; the product payload arrives from POST <region>.flipkart.com/api/4/page/fetch
// at $.RESPONSE.slots[].widget.data.products[].productInfo.value, which
// collectFlipkartProducts() already understands (server reuses it unchanged).
const PLAYWRIGHT_MODULE_FALLBACK = '/Users/zareef/.hermes/hermes-agent/node_modules/playwright';
const RENDER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const RENDER_PAGE_TIMEOUT_MS = Number(process.env.FLIPKART_RENDER_TIMEOUT_MS || 15000);
const FLIPKART_BUDGET_MS = Number(process.env.FLIPKART_BUDGET_MS || 90000);
const FLIPKART_PLAIN_TIMEOUT_MS = Number(process.env.FLIPKART_PLAIN_TIMEOUT_MS || 6000);
const debugFlipkart = (...args) => { if (process.env.DEBUG_FLIPKART) console.error('[flipkart]', ...args); };

function loadPlaywright() {
  try { return require('playwright'); } catch {}
  try { return require(PLAYWRIGHT_MODULE_FALLBACK); } catch {}
  return null;
}

// The installed Playwright build may ask for a browser revision the machine cache
// does not hold; fall back to any Chromium already downloaded under ms-playwright.
function resolveChromiumExecutable(pw) {
  const envPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  try { const own = pw.chromium.executablePath(); if (own && existsSync(own)) return undefined; } catch {}
  const roots = [
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright'),
    process.env.PLAYWRIGHT_BROWSERS_PATH
  ].filter(Boolean);
  const rels = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win/chrome.exe'
  ];
  for (const root of roots) {
    let dirs = [];
    try { dirs = readdirSync(root).filter(n => /^chromium-\d+$/.test(n)); } catch { continue; }
    dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const dir of dirs) for (const rel of rels) {
      const candidate = path.join(root, dir, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

let browserPromise = null;
let contextPromise = null;
let browserUnavailable = false;

async function getRenderBrowser() {
  if (browserUnavailable) return null;
  const pw = loadPlaywright();
  if (!pw) { browserUnavailable = true; debugFlipkart('playwright not installed — plain-fetch only'); return null; }
  if (!browserPromise) {
    const executablePath = resolveChromiumExecutable(pw);
    browserPromise = pw.chromium
      .launch({
        headless: true, executablePath,
        args: ['--disable-blink-features=AutomationControlled'],
        ...(SCRAPE_PROXY ? { proxy: { server: SCRAPE_PROXY } } : {})
      })
      .then(browser => {
        browser.on('disconnected', () => { browserPromise = null; contextPromise = null; });
        debugFlipkart('browser launched', browser.version(), executablePath || '(default cache path)', SCRAPE_PROXY ? '(via proxy)' : '(direct)');
        return browser;
      })
      .catch(err => {
        console.error('[flipkart] browser launch failed:', err.message);
        browserUnavailable = true;
        browserPromise = null;
        return null;
      });
  }
  return browserPromise;
}

async function getFlipkartContext() {
  const browser = await getRenderBrowser();
  if (!browser) return null;
  if (!contextPromise) {
    contextPromise = browser.newContext({
      userAgent: RENDER_UA, viewport: { width: 1366, height: 900 },
      locale: 'en-IN', timezoneId: 'Asia/Kolkata'
    }).catch(err => {
      console.error('[flipkart] context failed:', err.message);
      contextPromise = null;
      return null;
    });
  }
  return contextPromise;
}

let amazonContextPromise = null;

async function getAmazonContext() {
  const browser = await getRenderBrowser();
  if (!browser) return null;
  if (!amazonContextPromise) {
    amazonContextPromise = browser.newContext({
      userAgent: AMAZON_RENDER_UA, viewport: { width: 1366, height: 900 },
      locale: 'en-IN', timezoneId: 'Asia/Kolkata',
      extraHTTPHeaders: { 'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8' }
    }).then(async context => {
      // The interstitial fingerprints the automation flag, and a context with no
      // cookies looks like a cold bot on the very first request. Hide the flag and
      // seed a normal Indian session (homepage + INR/locale cookies) once, so the
      // eleven searches that follow all reuse a "warm" visitor.
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      await context.addCookies([
        { name: 'i18n-prefs', value: 'INR', domain: '.amazon.in', path: '/' },
        { name: 'lc-acbin', value: 'en_IN', domain: '.amazon.in', path: '/' }
      ]).catch(() => {});
      await context.request.get('https://www.amazon.in/', { timeout: 15000 }).catch(() => {});
      debugAmazon('context warmed');
      return context;
    }).catch(err => {
      console.error('[amazon] context failed:', err.message);
      amazonContextPromise = null;
      return null;
    });
  }
  return amazonContextPromise;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const jitter = (min, max) => Math.round(min + Math.random() * (max - min));

function withTimeout(promise, ms, fallback) {
  if (!(ms > 0)) return Promise.resolve(fallback);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); }
    );
  });
}

function shuffle(items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Flipkart's search page now server-renders its product cards into the DOM and
// no longer calls /api/N/page/fetch, so the response capture stays empty. This
// runs inside the page (serialised by page.evaluate) and reads the cards directly.
// MRP and discount are glued together in the card text, e.g. "₹99,99043% off".
function extractFlipkartDom() {
  const number = value => Number(value.replace(/,/g, ''));
  const isAmount = value => /^\d{1,2}(?:,\d{2})*,\d{3}$/.test(value) || /^\d{1,6}$/.test(value);
  const splitAmount = value => {
    for (const digits of [1, 2]) {
      const head = value.slice(0, -digits);
      if (isAmount(head)) return { mrp: number(head), discount: number(value.slice(-digits)) };
    }
    return null;
  };
  const out = [], seen = new Set();
  for (const anchor of document.querySelectorAll('a[href*="/p/itm"]')) {
    const href = anchor.getAttribute('href') || '';
    const idMatch = href.match(/\/p\/(itm[0-9a-f]+)/i);
    const id = idMatch ? idMatch[1] : '';
    if (!id || seen.has(id)) continue;
    const text = (anchor.innerText || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const prices = [...text.matchAll(/₹\s*(\d{1,2}(?:,\d{2})*,\d{3}|\d{1,6})(?![\d,])/g)].map(m => number(m[1]));
    const pay = prices[0] || 0;
    if (!pay) continue;
    const glued = text.match(/₹\s*([\d,]+)%\s*off/i);
    const split = glued ? splitAmount(glued[1]) : null;
    const mrp = split && split.mrp > pay ? split.mrp : 0;
    const discount = split ? split.discount : (mrp > pay ? Math.round((mrp - pay) / mrp * 100) : 0);
    const image = anchor.querySelector('img');
    seen.add(id);
    out.push({
      id, url: href,
      title: ((image && image.getAttribute('alt')) || text.slice(0, 120)).trim(),
      image: (image && (image.getAttribute('data-src') || image.currentSrc || image.getAttribute('src'))) || '',
      pay, mrp, discount
    });
  }
  return out;
}

// Opens one page, captures any product JSON responses and scrapes the rendered
// cards, feeds both through the existing accumulators, returns normalised deals.
async function fetchFlipkartRendered(query, category) {
  const context = await getFlipkartContext();
  if (!context) return [];
  let page;
  try { page = await context.newPage(); } catch (err) { debugFlipkart('newPage failed', err.message); contextPromise = null; return []; }

  const payloads = [];
  const inflight = [];
  page.on('response', response => {
    let url;
    try { url = response.url(); } catch { return; }
    if (!/\/api\/\d+\/page\/fetch/.test(url) || response.status() !== 200) return;
    inflight.push(response.json().then(json => { payloads.push(json); }).catch(() => {}));
  });

  const url = `https://www.flipkart.com/search?q=${encodeURIComponent(query)}&otracker=search&otracker1=search&marketplace=FLIPKART`;
  const started = Date.now();
  let domFound = [];
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: RENDER_PAGE_TIMEOUT_MS });
    await page.waitForSelector('a[href*="/p/itm"]', { timeout: 7000 }).catch(() => {});
    let settleAfter = Date.now() + 800;
    while (Date.now() < settleAfter) {
      await new Promise(r => setTimeout(r, 200));
      if (payloads.length) settleAfter = Math.min(settleAfter, Date.now() + 400);
    }
    domFound = await page.evaluate(extractFlipkartDom);
  } catch (err) {
    debugFlipkart('render failed', query, err.message);
  } finally {
    try { await page.close(); } catch {}
  }
  await Promise.allSettled(inflight);

  const found = [];
  for (const payload of payloads) collectFlipkartProducts(payload, found);
  found.push(...domFound);
  const deals = normalizeFlipkartDeals(found, category);
  debugFlipkart('rendered', query, 'payloads=' + payloads.length, 'dom=' + domFound.length, 'raw=' + found.length, 'deals=' + deals.length, (Date.now() - started) + 'ms');
  return deals;
}

// ── Amazon parser (deal JSON blob embedded in /deals) ────────────
const TECH_SYMBOLS = {
  gl_wireless: 'Mobiles', gl_wireless_accessory: 'Electronics',
  gl_electronics: 'Electronics', gl_pc: 'Laptops', gl_computers: 'Laptops',
  gl_big_law: 'Electronics', gl_wireless_products: 'Mobiles',
  gl_video_games: 'Electronics', gl_photo: 'Electronics', gl_musical_instruments: 'Electronics'
};
const TECH_KEYWORDS = /\b(phone|smartphone|mobile|laptop|notebook|tablet|ipad|macbook|earbud|headphone|headset|earphone|smart ?watch|smartwatch|band|tv|soundbar|speaker|charger|power ?bank|monitor|printer|router|pen ?drive|ssd|usb|camera|console|keyboard|mouse|nebula|fire tv|galaxy|iphone|redmi|realme|oneplus|poco|vivo|oppo|noise|boat|mivi|jbl|sony|samsung|asus|lenovo|acer|dell|logitech|sandisk|hp)\b/i;

function amazonTechCategory(symbol, title) {
  return TECH_SYMBOLS[symbol] || (TECH_KEYWORDS.test(title) ? 'Electronics' : '');
}

function parseAmazon(html) {
  const results = [];
  const seen = new Set();
  for (const match of html.matchAll(/\{"asin":"[A-Z0-9]{10}"/g)) {
    const raw = readJsonObjectAt(html, match.index);
    if (!raw) continue;
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    if (!o.asin || seen.has(o.asin) || o.dealDetails?.state !== 'AVAILABLE') continue;
    const pay = o.price?.priceToPay?.price, basis = o.price?.basisPrice?.price;
    const symbol = o.productCategory?.symbol || '';
    const title = String(o.title || '').replace(/…+$/, '').trim();
    const category = amazonTechCategory(symbol, title);
    if (!pay || !title || !category) continue;
    const img = o.image || {};
    const imgBase = img.lowRes?.baseUrl || img.hiRes?.baseUrl || '';
    const imgExt = img.lowRes?.extension || img.hiRes?.extension || 'jpg';
    const image = imgBase ? decodeHtml(`${imgBase}.${imgExt}`) : '';
    const badge = Number((o.dealBadge?.label?.content?.fragments || []).map(f => f.text).join(' ').match(/[\d.]+/)?.[0] || 0);
    const nv = parseFloat(pay), ov = basis ? parseFloat(basis) : 0;
    seen.add(o.asin);
    results.push({
      id: `amz-${o.asin}`, store: 'Amazon', title,
      image,
      url: amazonUrl(o.asin),
      price: `₹${Math.round(nv).toLocaleString('en-IN')}`,
      originalPrice: ov && ov > nv ? `₹${Math.round(ov).toLocaleString('en-IN')}` : '',
      discount: badge || (ov > nv ? Math.round(((ov - nv) / ov) * 100) : 0),
      available: true, category
    });
  }
  return results;
}

// ── Amazon search-page scraper (rendered) ────────────────────────
// The /deals JSON blob only ever carries ~10 tech items and every Amazon deal
// URL returns the identical payload, so extra breadth has to come from search
// pages. A bare fetch trips Amazon's `bm-verify` interstitial; a real browser
// clears it, so searches reuse the shared Chromium instance.
const AMAZON_RENDER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const AMAZON_SEARCHES = [
  { query: 'laptop', category: 'Laptops' },
  { query: 'smartphone', category: 'Mobiles' },
  { query: 'mobile phone under 15000', category: 'Mobiles' },
  { query: 'wireless earbuds', category: 'Electronics' },
  { query: 'smart watch', category: 'Electronics' },
  { query: 'tablet', category: 'Electronics' },
  { query: 'smart tv', category: 'Electronics' },
  { query: 'camera', category: 'Electronics' },
  { query: 'macbook', category: 'Laptops' },
  { query: 'iphone', category: 'Mobiles' },
  { query: 'samsung galaxy s', category: 'Mobiles' }
];
const AMAZON_BUDGET_MS = Number(process.env.AMAZON_BUDGET_MS || 150000);
const AMAZON_PAGE_TIMEOUT_MS = Number(process.env.AMAZON_PAGE_TIMEOUT_MS || 15000);
// A blocked query renders no result cards at all, so the selector wait is really
// a bot check. Detect it quickly and retry before writing the query off.
const AMAZON_SELECTOR_WAIT_MS = Number(process.env.AMAZON_SELECTOR_WAIT_MS || 4000);
const AMAZON_QUERY_RETRIES = Number(process.env.AMAZON_QUERY_RETRIES || 2);
const debugAmazon = (...args) => { if (process.env.DEBUG_AMAZON) console.error('[amazon]', ...args); };

// Runs inside the page (serialised by page.evaluate): reads the search result
// cards Amazon server-renders. Prices come from the `.a-offscreen` spans so the
// Indian lakh/comma grouping is parsed without locale guessing.
function extractAmazonSearch() {
  const text = el => (el ? (el.textContent || '').trim() : '');
  const amount = value => { const digits = String(value).replace(/[^\d]/g, ''); return digits ? Number(digits) : 0; };
  const out = [], seen = new Set();
  for (const card of document.querySelectorAll('[data-component-type="s-search-result"], div.s-result-item[data-asin]')) {
    const asin = card.getAttribute('data-asin') || '';
    if (!/^[A-Z0-9]{10}$/.test(asin) || seen.has(asin)) continue;
    const img = card.querySelector('img.s-image');
    const title = text(card.querySelector('h2 a span') || card.querySelector('h2 span') || card.querySelector('h2 a')) || (img && img.getAttribute('alt')) || '';
    const pay = amount(text(card.querySelector('.a-price:not(.a-text-price) .a-offscreen') || card.querySelector('.a-price .a-offscreen')));
    const mrp = amount(text(card.querySelector('.a-price.a-text-price .a-offscreen') || card.querySelector('span[data-a-strike="true"] .a-offscreen')));
    if (!title || !pay) continue;
    seen.add(asin);
    out.push({ asin, title: title.slice(0, 220), image: img ? (img.getAttribute('src') || '') : '', pay, mrp });
  }
  return out;
}

function normalizeAmazonSearchDeals(items, category) {
  const inr = n => `₹${Math.round(n).toLocaleString('en-IN')}`;
  return items.map(p => ({
    id: `amz-${p.asin}`, store: 'Amazon', title: decodeHtml(p.title),
    image: decodeHtml(p.image),
    url: amazonUrl(p.asin),
    price: inr(p.pay), originalPrice: p.mrp > p.pay ? inr(p.mrp) : '',
    discount: p.mrp > p.pay ? Math.round(((p.mrp - p.pay) / p.mrp) * 100) : 0,
    available: true, category
  }));
}

// A single navigation. Returns [] when no result cards render — either a genuinely
// empty result set or, far more often on a datacenter IP, the robot interstitial.
async function amazonSearchAttempt(context, query, category, attempt) {
  let page;
  try { page = await context.newPage(); } catch (err) { debugAmazon('newPage failed', err.message); amazonContextPromise = null; return []; }
  const started = Date.now();
  try {
    await page.goto(`https://www.amazon.in/s?k=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: AMAZON_PAGE_TIMEOUT_MS });
    await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: AMAZON_SELECTOR_WAIT_MS }).catch(() => {});
    await sleep(300);
    const items = await page.evaluate(extractAmazonSearch);
    debugAmazon('attempt', attempt, query, 'items=' + items.length, (Date.now() - started) + 'ms');
    return normalizeAmazonSearchDeals(items, category);
  } catch (err) {
    debugAmazon('attempt', attempt, query, 'failed:', err.message);
    return [];
  } finally {
    try { await page.close(); } catch {}
  }
}

// Retries a query the interstitial blocked. A failed query is nearly free to
// repeat (it returns in ~4s with no cards), and the block is per-request, so the
// retry usually lands on a clean page and recovers the full result set.
async function fetchAmazonSearchRendered(query, category) {
  const context = await getAmazonContext();
  if (!context) return [];
  for (let attempt = 0; attempt <= AMAZON_QUERY_RETRIES; attempt++) {
    const deals = await amazonSearchAttempt(context, query, category, attempt);
    if (deals.length) return deals;
    if (attempt < AMAZON_QUERY_RETRIES) await sleep(jitter(1500, 4000));
  }
  debugAmazon('giving up on', query, 'after', AMAZON_QUERY_RETRIES + 1, 'attempts');
  return [];
}

// ── Amazon Creators API (official product data) ──────────────────
// The Creators API is the official successor to the deprecated Product Advertising
// API 5.0. It is an authenticated REST call, so unlike page scraping it does not
// care about the caller's IP address — precisely the CI shortfall the proxy below
// only works around. The catch is Amazon's gate: the associate account must have
// made 10 qualified sales in the trailing 30 days, and until then every call
// answers 403 AssociateNotEligible. This path therefore runs alongside the scraper
// rather than replacing it: whatever the API returns is merged with the scraped
// rows, and any failure (including that 403) simply contributes nothing.
const CREATORS_CLIENT_ID = process.env.AMAZON_CREATORS_CLIENT_ID || '';
const CREATORS_CLIENT_SECRET = process.env.AMAZON_CREATORS_CLIENT_SECRET || '';
const CREATORS_ENABLED = Boolean(CREATORS_CLIENT_ID && CREATORS_CLIENT_SECRET);
const CREATORS_MARKETPLACE = process.env.AMAZON_MARKETPLACE || 'www.amazon.in';
// Credential version 3.2 (EU home region) selects this Login-with-Amazon token
// endpoint; the credentials themselves are global and the marketplace is chosen
// per call by the x-marketplace header.
const CREATORS_TOKEN_URL = process.env.AMAZON_CREATORS_TOKEN_URL || 'https://api.amazon.co.uk/auth/o2/token';
const CREATORS_SEARCH_URL = 'https://creatorsapi.amazon/catalog/v1/searchItems';
const CREATORS_ITEM_COUNT = 10;
const CREATORS_PAGES = Number(process.env.AMAZON_CREATORS_PAGES || 2);
const CREATORS_RESOURCES = [
  'images.primary.large', 'itemInfo.title',
  'offersV2.listings.price', 'offersV2.listings.availability', 'offersV2.listings.dealDetails'
];
// Access tokens last an hour and the token endpoint rate-limits per client — the
// docs expect at most one token per hour, per credential. Cache it on disk so the
// 10-minute cron reuses it; CI restores this file from the same Actions cache as
// the merge ledger.
const creatorsTokenFile = path.join(__dirname, '.creators-token.json');

function readCachedCreatorsToken() {
  try {
    const saved = JSON.parse(readFileSync(creatorsTokenFile, 'utf8'));
    if (saved && saved.value && saved.expiresAt - 120000 > Date.now()) return saved.value;
  } catch {}
  return '';
}

async function getCreatorsToken() {
  const cached = readCachedCreatorsToken();
  if (cached) return cached;
  const res = await fetch(CREATORS_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: CREATORS_CLIENT_ID,
      client_secret: CREATORS_CLIENT_SECRET,
      scope: 'creatorsapi::default'
    }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await res.json().catch(() => ({}));
  if (!body.access_token) throw new Error(`token HTTP ${res.status} ${body.error_description || body.error || ''}`.trim());
  const token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
  try { writeFileSync(creatorsTokenFile, JSON.stringify(token)); } catch {}
  return token.value;
}

async function creatorsSearch(token, body) {
  const res = await fetch(CREATORS_SEARCH_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-marketplace': CREATORS_MARKETPLACE
    },
    body: JSON.stringify({ marketplace: CREATORS_MARKETPLACE, partnerTag: AMAZON_TAG, ...body }),
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// Throttles and 5xx are worth retrying; a 4xx reason (bad partner tag, ineligible
// account) never is, so it throws at once and the caller drops to the scraper.
async function creatorsRequest(token, body) {
  for (let attempt = 0; ; attempt++) {
    const { status, json } = await creatorsSearch(token, body);
    if (status === 200) return json;
    const reason = json.reason || json.type || `HTTP ${status}`;
    if ((status === 429 || status >= 500) && attempt < 2) {
      await sleep(Number(json.retryAfterSeconds || 0) * 1000 || 2000 * (attempt + 1));
      continue;
    }
    throw new Error(reason);
  }
}

// OffersV2 exposes only the featured buy-box listing; its savings block is the
// discount we show, falling back to the saving basis when a percentage is absent.
function normalizeCreatorsItems(items, category) {
  const out = [];
  for (const item of items || []) {
    const title = item.itemInfo && item.itemInfo.title && item.itemInfo.title.displayValue;
    if (!item.asin || !title) continue;
    const listings = (item.offersV2 && item.offersV2.listings) || [];
    const listing = listings.find(l => l.isBuyBoxWinner) || listings[0] || {};
    const price = listing.price || {};
    const money = price.money || {};
    const pay = Number(money.amount);
    if (!pay) continue;
    const basisMoney = (price.savingBasis && price.savingBasis.money) || {};
    const basis = Number(basisMoney.amount) || 0;
    const pct = Number(price.savings && price.savings.percentage) || 0;
    const images = (item.images && item.images.primary) || {};
    const image = ((images.large || images.medium || images.small) || {}).url || '';
    out.push({
      id: `amz-${item.asin}`, store: 'Amazon', title: decodeHtml(String(title)),
      image, url: amazonUrl(item.asin),
      price: money.displayAmount || `₹${Math.round(pay).toLocaleString('en-IN')}`,
      originalPrice: basis > pay ? (basisMoney.displayAmount || `₹${Math.round(basis).toLocaleString('en-IN')}`) : '',
      discount: pct || (basis > pay ? Math.round(((basis - pay) / basis) * 100) : 0),
      available: stockAvailable(listing.availability), category
    });
  }
  return out;
}

// Returns the store block, or null when the API is off/unusable so the caller can
// carry on with the scraper alone. A fatal error aborts the query loop immediately
// rather than repeating a doomed request eleven times.
async function loadFromAmazonCreators() {
  if (!CREATORS_ENABLED) return null;
  const deals = [];
  const deadline = Date.now() + AMAZON_BUDGET_MS;
  try {
    const token = await getCreatorsToken();
    for (const { query, category } of shuffle(AMAZON_SEARCHES)) {
      for (let page = 1; page <= CREATORS_PAGES; page++) {
        if (Date.now() > deadline) throw new Error('budget exhausted');
        const json = await creatorsRequest(token, {
          keywords: query, itemCount: CREATORS_ITEM_COUNT, itemPage: page, resources: CREATORS_RESOURCES
        });
        const items = (json.searchResult && json.searchResult.items) || [];
        deals.push(...normalizeCreatorsItems(items, category));
        if (items.length < CREATORS_ITEM_COUNT) break;
        await sleep(1100);
      }
    }
  } catch (err) {
    debugAmazon('creators api unusable:', err.message);
    if (!deals.length) return null;
  }
  if (!deals.length) return null;
  const seen = new Set();
  const unique = deals.filter(d => !seen.has(d.id) && seen.add(d.id));
  debugAmazon('creators api complete', 'deals=' + unique.length);
  return { status: 'live', deals: unique, total: unique.length, blocked: 0 };
}

// ── Data loading ─────────────────────────────────────────────────
const AMAZON_DEAL_URLS = [
  'https://www.amazon.in/deals',
  'https://www.amazon.in/gp/goldbox'
];

async function fetchAmazonHtml() {
  let lastError;
  for (const url of AMAZON_DEAL_URLS) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8'
        }
      });
      if (!res.ok) { lastError = new Error(`HTTP ${res.status}`); continue; }
      const html = await res.text();
      if (html.includes('productSearchResponse')) return html;
      lastError = new Error('no deal payload');
    } catch (err) { lastError = err; }
  }
  throw lastError || new Error('Amazon unavailable');
}

// The page scraper on its own: the curated /deals blob plus the rendered search
// pages. Returns the raw store block so the caller can merge it with the API.
async function loadFromAmazonScrape() {
  let baseDeals = [];
  let baseError = '';
  try {
    baseDeals = parseAmazon(await fetchAmazonHtml());
  } catch (err) { baseError = err.message; }

  // Search pages supply the bulk of the catalogue; the deal blob adds curated
  // discounts. Rotating the query order nudges the budget-limited tail around.
  const searchDeals = [];
  let blocked = baseDeals.length ? 0 : 1;
  const deadline = Date.now() + AMAZON_BUDGET_MS;
  for (const { query, category } of shuffle(AMAZON_SEARCHES)) {
    const remaining = deadline - Date.now();
    if (remaining < 8000) { blocked++; continue; }
    const rendered = await withTimeout(fetchAmazonSearchRendered(query, category), remaining - 500, []);
    if (!rendered.length) blocked++;
    searchDeals.push(...rendered);
    // Space the navigations out a little; back-to-back requests from one IP are
    // what triggers the interstitial in the first place.
    await sleep(jitter(400, 1500));
  }

  const seen = new Set();
  const deals = [...baseDeals, ...searchDeals].filter(d => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });

  debugAmazon('scrape complete', 'base=' + baseDeals.length, 'search=' + searchDeals.length, 'merged=' + deals.length, 'blocked=' + blocked, baseError ? ('baseError=' + baseError) : '');

  return {
    status: deals.length ? 'live' : 'error',
    deals,
    total: deals.length,
    blocked,
    ...(deals.length ? {} : { reason: baseError || 'Amazon unavailable' })
  };
}

// Merge the two independent Amazon sources: the official Creators API (IP-independent,
// authoritative price/availability) and the page scraper (search-page breadth the API
// does not cover). They run in parallel and are deduplicated by ASIN with the API row
// winning on a clash. Either side may be empty — API disabled or blocked, scraper served
// the interstitial — without affecting the other, so one source degrading never loses
// the other's rows.
async function loadFromAmazon() {
  const [viaCreators, viaScrape] = await Promise.all([
    loadFromAmazonCreators(),
    loadFromAmazonScrape()
  ]);

  const apiDeals = (viaCreators && viaCreators.deals) || [];
  const seen = new Set();
  const deals = [...apiDeals, ...viaScrape.deals].filter(d => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });

  debugAmazon('load complete', 'creators=' + apiDeals.length, 'scrape=' + viaScrape.deals.length, 'merged=' + deals.length, 'blocked=' + viaScrape.blocked);

  return {
    status: deals.length ? 'live' : 'error',
    deals,
    total: deals.length,
    blocked: viaScrape.blocked,
    ...(deals.length ? {} : { reason: viaScrape.reason || 'Amazon unavailable' })
  };
}

async function fetchFlipkartHtml(query) {
  const url = `https://www.flipkart.com/search?q=${encodeURIComponent(query)}&otracker=search&otracker1=search&marketplace=FLIPKART`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FLIPKART_PLAIN_TIMEOUT_MS),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function loadFromFlipkart() {
  const searches = [
    { query: 'iphone', category: 'Mobiles' },
    { query: 'macbook', category: 'Laptops' },
    { query: 'samsung galaxy s', category: 'Mobiles' },
    { query: 'smartphone', category: 'Mobiles' },
    { query: 'mobile phone under 15000', category: 'Mobiles' },
    { query: 'laptop', category: 'Laptops' },
    { query: 'wireless earbuds', category: 'Electronics' },
    { query: 'smart tv', category: 'Electronics' },
    { query: 'tablet', category: 'Electronics' },
    { query: 'camera', category: 'Electronics' },
    { query: 'wearable watch', category: 'Electronics' }
  ];

  const allDeals = [];
  let failedCount = 0;
  let renderedQueries = 0;
  const deadline = Date.now() + FLIPKART_BUDGET_MS;
  const remaining = () => deadline - Date.now();

  // Sequential (not 8-parallel): a shared browser must not be hammered, and the
  // hard deadline keeps /api/deals from ever hanging.
  for (const { query, category } of searches) {
    let deals = [];

    // 1) Plain fetch first — unchanged legacy behaviour, still free if Akamai allows it.
    if (remaining() > 2000) {
      try { deals = parseFlipkart(await fetchFlipkartHtml(query), category); } catch {}
    }

    // 2) Rendered fallback for queries the skeleton left empty.
    if (!deals.length && remaining() > 3000) {
      const rendered = await withTimeout(fetchFlipkartRendered(query, category), remaining() - 500, []);
      if (rendered.length) { deals = rendered; renderedQueries++; }
    }

    if (!deals.length) failedCount++;
    allDeals.push(...deals);
  }

  debugFlipkart('load complete', 'deals=' + allDeals.length, 'renderedQueries=' + renderedQueries, 'failed=' + failedCount, 'elapsed=' + (FLIPKART_BUDGET_MS - remaining()) + 'ms');

  return {
    status: allDeals.length ? (failedCount >= searches.length ? 'error' : 'live') : 'error',
    deals: allDeals,
    total: allDeals.length,
    blocked: failedCount
  };
}

// Deals carry firstSeen/lastSeen. Those stamps are the expiry clock: a row that
// stops appearing in fresh scrapes survives a degraded merge, then ages out.
function annotateFresh(freshDeals, previousDeals, now) {
  const prev = previousDeals || [];
  const prevById = new Map(prev.map(d => [d.id, d]));
  const stamp = new Date(now).toISOString();
  // With no baseline every deal is "seen for the first time", which would badge the
  // whole page. Backdate the seed run so only later arrivals count as new.
  const seeded = prev.length === 0;
  const seedStamp = new Date(now - 25 * 60 * 60 * 1000).toISOString();
  return freshDeals.map(d => {
    const prior = prevById.get(d.id);
    const firstSeen = (prior && prior.firstSeen) ? prior.firstSeen : (seeded ? seedStamp : stamp);
    return {
      ...d, firstSeen, lastSeen: stamp, stale: false,
      isNew: now - (Date.parse(firstSeen) || now) < 24 * 60 * 60 * 1000
    };
  });
}

// Merge one store's fresh result with what we saw last time, expiring rows that
// are gone. `degraded` says some queries never rendered this run, which is the
// only case where an absent row cannot be trusted to have expired. Returns a
// store block ({status, deals, total}) plus counters for logs.
function mergeStore(freshDeals, previousDeals, now, degraded) {
  const prev = Array.isArray(previousDeals) ? previousDeals : [];
  const dealt = annotateFresh(freshDeals || [], prev, now);

  // Store returned nothing at all — hold the newest rows briefly so one blocked
  // run does not blank the page, then let them expire.
  if (!dealt.length) {
    const held = prev.filter(d => now - (Date.parse(d.lastSeen) || 0) < STORE_STALE_MS);
    return {
      status: held.length ? 'stale' : 'error',
      deals: held.map(d => ({ ...d, stale: true })),
      total: held.length,
      fresh: 0, retained: held.length, expired: prev.length - held.length,
      ...(held.length ? { stale: true } : { reason: 'store unavailable' })
    };
  }

  // Every query answered: the fresh set is trustworthy, so a row that is absent
  // is genuinely gone and drops out now.
  const freshIds = new Set(dealt.map(d => d.id));
  if (!degraded) {
    return {
      status: 'live',
      deals: dealt.slice(0, MAX_STORE_DEALS),
      total: dealt.length,
      fresh: dealt.length, retained: 0,
      expired: prev.filter(d => !freshIds.has(d.id)).length
    };
  }

  // Some query was blocked, so a missing row may simply not have been rendered.
  // Keep those rows marked stale and let DEAL_TTL_MS expire them — this is what
  // stops a datacenter run that scrapes less than a local one from deleting the
  // deals it never got to see.
  const carried = [];
  let expired = 0;
  for (const d of prev) {
    if (freshIds.has(d.id)) continue;
    if (now - (Date.parse(d.lastSeen) || 0) < DEAL_TTL_MS) carried.push({ ...d, stale: true });
    else expired++;
  }
  const merged = [...dealt, ...carried].slice(0, MAX_STORE_DEALS);
  return {
    status: carried.length ? 'partial' : 'live',
    deals: merged,
    total: merged.length,
    fresh: dealt.length, retained: carried.length, expired
  };
}

function storeBlock(merged) {
  return {
    status: merged.status,
    deals: merged.deals,
    total: merged.total,
    ...(merged.stale ? { stale: true } : {}),
    ...(merged.reason ? { reason: merged.reason } : {})
  };
}

// Pulls the rupee value out of a display price ("₹1,29,900" → 129900).
function dealPriceValue(deal) {
  return Number(String((deal && deal.price) || '').replace(/[^\d]/g, '')) || 0;
}

// A deal reaches the page only if it was seen fresh this run, is in stock, and
// costs at least MIN_DEAL_PRICE. Stale carries and out-of-stock rows are dropped
// here rather than merely flagged, so nothing dead can reach the feed.
function isPublishableDeal(deal) {
  if (!deal || deal.stale) return false;
  if (deal.available === false) return false;
  return dealPriceValue(deal) >= MIN_DEAL_PRICE;
}

// Filters a store's merged pool down to publishable deals, dedupes by id and
// caps it at `budget` so the combined feed respects MAX_DEALS.
function finaliseStoreDeals(deals, budget) {
  const seen = new Set(), out = [];
  for (const d of deals || []) {
    if (!isPublishableDeal(d) || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
    if (out.length >= budget) break;
  }
  return out;
}

async function scrapeDeals() {
  const [amazonFresh, flipkartFresh] = await Promise.all([
    loadFromAmazon(),
    loadFromFlipkart()
  ]);

  const now = Date.now();
  const previous = cache;
  const amazon = mergeStore(amazonFresh.deals, previous && previous.amazon && previous.amazon.deals, now, (amazonFresh.blocked || 0) > 0);
  const flipkart = mergeStore(flipkartFresh.deals, previous && previous.flipkart && previous.flipkart.deals, now, (flipkartFresh.blocked || 0) > 0);

  // Publish only fresh, in-stock, ₹1000+ deals, split 70/30 and capped so the two
  // stores together never exceed MAX_DEALS.
  const amazonBudget = Math.round(MAX_DEALS * AMAZON_SHARE);
  const amazonDeals = finaliseStoreDeals(amazon.deals, amazonBudget);
  const flipkartDeals = finaliseStoreDeals(flipkart.deals, MAX_DEALS - amazonBudget);

  // Deduplicate across stores
  const seen = new Set();
  const deals = [...amazonDeals, ...flipkartDeals].filter(d => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });

  cache = {
    updatedAt: new Date(now).toISOString(),
    source: 'Direct Amazon & Flipkart pages',
    amazon: { ...storeBlock(amazon), deals: amazonDeals, total: amazonDeals.length },
    flipkart: { ...storeBlock(flipkart), deals: flipkartDeals, total: flipkartDeals.length },
    total: deals.length
  };
  cachedAt = now;

  const payload = JSON.stringify(cache);
  await Promise.all([
    writeFile(cacheFile, payload).catch(() => {}),
    writeFile(stateFile, payload).catch(() => {})
  ]);

  for (const [name, merged, published] of [['amazon', amazon, amazonDeals], ['flipkart', flipkart, flipkartDeals]]) {
    console.log(`[deals] ${name}: scraped=${merged.fresh} dropped=${merged.deals.length - published.length} published=${published.length} status=${merged.status}`);
  }
  console.log(`[deals] merged ${deals.length} deals (cap ${MAX_DEALS}, min ₹${MIN_DEAL_PRICE}) at ${cache.updatedAt}`);
  return cache;
}

async function loadDeals(force = false) {
  if (!force && cache && Date.now() - cachedAt < refreshMs) return cache;
  // One shared in-flight scrape: overlapping requests cannot race and let a
  // slower, emptier result overwrite the cache.
  if (!inflight) inflight = scrapeDeals().finally(() => { inflight = null; });
  return inflight;
}

// ── Local push storage ───────────────────────────────────────────
// In production /api/push/* is a Cloudflare Pages Function over Workers KV
// (functions/api/push/). Locally the same routes are served from a gitignored JSON
// file, so `npm start` exercises the whole subscription flow.
const pushSubsFile = path.join(__dirname, '.push-subs.json');
const PUSH_SUB_PREFIX = 'sub:';

function pushSubscriptionId(endpoint) {
  return createHash('sha256').update(endpoint).digest('hex');
}
function readPushSubs() {
  try { return JSON.parse(readFileSync(pushSubsFile, 'utf8')); } catch { return {}; }
}
function writePushSubs(subs) {
  try { writeFileSync(pushSubsFile, JSON.stringify(subs, null, 2)); } catch {}
}
function isPushSubscription(value) {
  return Boolean(value) && typeof value.endpoint === 'string' && value.endpoint.startsWith('https://') &&
    value.keys && typeof value.keys.p256dh === 'string' && typeof value.keys.auth === 'string';
}
// Production serves the public key from wrangler.toml [vars]; locally it can come
// from the gitignored .vapid.json that `npx web-push generate-vapid-keys` leaves in
// the project root.
function localVapidPublicKey() {
  if (process.env.VAPID_PUBLIC_KEY) return process.env.VAPID_PUBLIC_KEY;
  try { return JSON.parse(readFileSync(path.join(__dirname, '.vapid.json'), 'utf8')).publicKey || ''; } catch { return ''; }
}
function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// ── Static files ─────────────────────────────────────────────────
// The site is plain files under public/, so the dev server mirrors the deployed
// layout: the service worker, manifest and icons all load from the root.
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

async function serveStatic(response, pathname) {
  const publicDir = path.join(__dirname, 'public');
  let requested = '';
  try { requested = decodeURIComponent(pathname); } catch {}
  const relative = requested === '/' || requested === '' ? 'index.html' : requested.replace(/^\/+/, '');
  const target = path.resolve(publicDir, relative);
  // Never let a crafted path climb out of public/.
  if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  try {
    const body = await readFile(target);
    response.writeHead(200, { 'content-type': MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

// ── Server ───────────────────────────────────────────────────────
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  
  if (url.pathname === '/api/deals') {
    const data = await loadDeals(url.searchParams.get('refresh') === '1');
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    response.end(JSON.stringify(data));
    return;
  }
  
  if (url.pathname === '/api/push/key') {
    // The local file store is always writable, so a key is all `ready` needs here.
    const key = localVapidPublicKey();
    sendJson(response, 200, { key, ready: Boolean(key) });
    return;
  }

  if (url.pathname === '/api/push/subscribe') {
    const subs = readPushSubs();

    if (request.method === 'POST') {
      let body;
      try { body = JSON.parse((await readRequestBody(request)) || '{}'); } catch { sendJson(response, 400, { ok: false, error: 'Expected a JSON body.' }); return; }
      const subscription = body && body.subscription ? body.subscription : body;
      if (!isPushSubscription(subscription)) { sendJson(response, 400, { ok: false, error: 'Not a valid push subscription.' }); return; }
      subs[PUSH_SUB_PREFIX + pushSubscriptionId(subscription.endpoint)] = {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
        createdAt: new Date().toISOString(),
        userAgent: (request.headers['user-agent'] || '').slice(0, 200)
      };
      writePushSubs(subs);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'DELETE') {
      let endpoint = url.searchParams.get('endpoint') || '';
      if (!endpoint) {
        try {
          const body = JSON.parse((await readRequestBody(request)) || '{}');
          endpoint = (body && (body.endpoint || (body.subscription && body.subscription.endpoint))) || '';
        } catch {}
      }
      if (!endpoint) { sendJson(response, 400, { ok: false, error: 'Missing endpoint.' }); return; }
      delete subs[PUSH_SUB_PREFIX + pushSubscriptionId(endpoint)];
      writePushSubs(subs);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET') {
      // Mirrors the deployed route: the list exists for the daily sender, so it is
      // gated by the shared secret whenever one is configured.
      const secret = process.env.PUSH_ADMIN_SECRET || '';
      if (secret && request.headers.authorization !== `Bearer ${secret}`) { sendJson(response, 401, { ok: false, error: 'Unauthorized.' }); return; }
      const subscriptions = Object.values(subs);
      sendJson(response, 200, { ok: true, count: subscriptions.length, subscriptions });
      return;
    }

    sendJson(response, 405, { ok: false, error: 'Method not allowed.' });
    return;
  }
  
  await serveStatic(response, url.pathname);
});

async function closeBrowser() {
  const flipkartContext = browserContext();
  const amazonContext = amazonContextHandle();
  const browser = browserHandle();
  try { const c = await flipkartContext; if (c) await c.close(); } catch {}
  try { const c = await amazonContext; if (c) await c.close(); } catch {}
  try { const b = await browser; if (b) await b.close(); } catch {}
}

// Close the shared browser on shutdown so Chromium never outlives the server.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await closeBrowser();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
function browserContext() { const p = contextPromise; contextPromise = null; return p; }
function amazonContextHandle() { const p = amazonContextPromise; amazonContextPromise = null; return p; }
function browserHandle() { const p = browserPromise; browserPromise = null; browserUnavailable = true; return p; }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Entry point ──────────────────────────────────────────────────
// `--once` runs a single scrape and exits; the scheduled GitHub Actions job uses it
// to refresh public/deals.json. Otherwise start the local development server.
if (process.argv.includes('--once')) {
  let failed = false;
  scrapeDeals()
    .catch(err => { failed = true; console.error('[deals] scrape failed:', err.message); })
    .then(closeBrowser)
    .then(() => {
      console.log(`Wrote ${cache ? cache.total : 0} deals to ${cacheFile}`);
      process.exit(failed ? 1 : 0);
    });
} else {
  server.listen(port, () => console.log(`Deal Grabber listening at http://localhost:${port}`));
}
