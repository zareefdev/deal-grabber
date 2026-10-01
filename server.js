const http = require('node:http');
const { readFile, writeFile } = require('node:fs/promises');
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.PORT || 4173);
const refreshMs = Number(process.env.REFRESH_MS || 10 * 60 * 1000);
const cacheFile = path.join(__dirname, 'public', 'deals.json');
// public/deals.json is the artefact that gets deployed; this private sidecar keeps
// the merge ledger alive between runs. It is gitignored locally and restored from
// the Actions cache in CI, so a fresh checkout still knows what it saw last time.
const stateFile = path.join(__dirname, '.deal-state.json');

// A store's fresh scrape becomes authoritative once it recovers at least this
// share of the previous snapshot. Below it we assume the store partially blocked
// us, merge instead of replacing, and let the missing rows age out.
const MERGE_KEEP_RATIO = Number(process.env.MERGE_KEEP_RATIO || 0.6);
// Unseen deals survive that merge for this long before being expired for good.
const DEAL_TTL_MS = Number(process.env.DEAL_TTL_MS || 24 * 60 * 60 * 1000);
// A fully blocked store may hold its last snapshot for at most this long.
const STORE_STALE_MS = Number(process.env.STORE_STALE_MS || 3 * 60 * 60 * 1000);
const MAX_STORE_DEALS = Number(process.env.MAX_STORE_DEALS || 600);

let cache;
let cachedAt = 0;
let inflight = null;

// Restore the last good scrape so a restart cannot regress the page to one store
// while Flipkart is transiently blocked. The sidecar wins because it is rewritten
// on every scrape, whereas the deployed file may be a stale committed snapshot.
for (const file of [stateFile, cacheFile]) {
  try {
    const restored = JSON.parse(readFileSync(file, 'utf8'));
    if (restored && restored.amazon && restored.flipkart) {
      cache = restored;
      cachedAt = Date.parse(restored.updatedAt) || 0;
      break;
    }
  } catch {}
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
      discount: Number(info.discountPercentage?.value || (mrp > pay ? Math.round(((mrp - pay) / mrp) * 100) : 0))
    });
  }
  for (const k in node) collectFlipkartProducts(node[k], out);
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
      discount: Math.round(p.discount), available: true, category
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
      .launch({ headless: true, executablePath, args: ['--disable-blink-features=AutomationControlled'] })
      .then(browser => {
        browser.on('disconnected', () => { browserPromise = null; contextPromise = null; });
        debugFlipkart('browser launched', browser.version(), executablePath || '(default cache path)');
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
    }).catch(err => {
      console.error('[amazon] context failed:', err.message);
      amazonContextPromise = null;
      return null;
    });
  }
  return amazonContextPromise;
}

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
      url: `https://www.amazon.in/dp/${o.asin}`,
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
const AMAZON_BUDGET_MS = Number(process.env.AMAZON_BUDGET_MS || 75000);
const AMAZON_PAGE_TIMEOUT_MS = Number(process.env.AMAZON_PAGE_TIMEOUT_MS || 15000);
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
    url: `https://www.amazon.in/dp/${p.asin}`,
    price: inr(p.pay), originalPrice: p.mrp > p.pay ? inr(p.mrp) : '',
    discount: p.mrp > p.pay ? Math.round(((p.mrp - p.pay) / p.mrp) * 100) : 0,
    available: true, category
  }));
}

async function fetchAmazonSearchRendered(query, category) {
  const context = await getAmazonContext();
  if (!context) return [];
  let page;
  try { page = await context.newPage(); } catch (err) { debugAmazon('newPage failed', err.message); amazonContextPromise = null; return []; }
  const started = Date.now();
  try {
    await page.goto(`https://www.amazon.in/s?k=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: AMAZON_PAGE_TIMEOUT_MS });
    await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 7000 }).catch(() => {});
    await page.waitForTimeout(400);
    const items = await page.evaluate(extractAmazonSearch);
    debugAmazon('rendered', query, 'items=' + items.length, (Date.now() - started) + 'ms');
    return normalizeAmazonSearchDeals(items, category);
  } catch (err) {
    debugAmazon('render failed', query, err.message);
    return [];
  } finally {
    try { await page.close(); } catch {}
  }
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

async function loadFromAmazon() {
  let baseDeals = [];
  let baseError = '';
  try {
    baseDeals = parseAmazon(await fetchAmazonHtml());
  } catch (err) { baseError = err.message; }

  // Search pages supply the bulk of the catalogue; the deal blob adds curated
  // discounts. Rotating the query order nudges the budget-limited tail around.
  const searchDeals = [];
  const deadline = Date.now() + AMAZON_BUDGET_MS;
  for (const { query, category } of shuffle(AMAZON_SEARCHES)) {
    const remaining = deadline - Date.now();
    if (remaining < 2500) break;
    const rendered = await withTimeout(fetchAmazonSearchRendered(query, category), remaining - 500, []);
    searchDeals.push(...rendered);
  }

  const seen = new Set();
  const deals = [...baseDeals, ...searchDeals].filter(d => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });

  debugAmazon('load complete', 'base=' + baseDeals.length, 'search=' + searchDeals.length, 'merged=' + deals.length, baseError ? ('baseError=' + baseError) : '');

  return {
    status: deals.length ? 'live' : 'error',
    deals,
    total: deals.length,
    ...(deals.length ? {} : { reason: baseError || 'Amazon unavailable' })
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
    total: allDeals.length
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
// are gone. Returns a store block ({status, deals, total}) plus counters for logs.
function mergeStore(freshDeals, previousDeals, now) {
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

  // Healthy scrape: fresh is the source of truth, so anything absent has expired.
  if (!prev.length || dealt.length >= prev.length * MERGE_KEEP_RATIO) {
    const freshIds = new Set(dealt.map(d => d.id));
    return {
      status: 'live',
      deals: dealt.slice(0, MAX_STORE_DEALS),
      total: dealt.length,
      fresh: dealt.length, retained: 0,
      expired: prev.filter(d => !freshIds.has(d.id)).length
    };
  }

  // Partial block: keep fresh plus every recent row we could not reconfirm.
  const freshIds = new Set(dealt.map(d => d.id));
  const carried = [];
  let expired = 0;
  for (const d of prev) {
    if (freshIds.has(d.id)) continue;
    if (now - (Date.parse(d.lastSeen) || 0) < DEAL_TTL_MS) carried.push({ ...d, stale: true });
    else expired++;
  }
  const merged = [...dealt, ...carried].slice(0, MAX_STORE_DEALS);
  return {
    status: 'partial',
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

async function scrapeDeals() {
  const [amazonFresh, flipkartFresh] = await Promise.all([
    loadFromAmazon(),
    loadFromFlipkart()
  ]);

  const now = Date.now();
  const previous = cache;
  const amazon = mergeStore(amazonFresh.deals, previous && previous.amazon && previous.amazon.deals, now);
  const flipkart = mergeStore(flipkartFresh.deals, previous && previous.flipkart && previous.flipkart.deals, now);

  // Deduplicate across stores
  const seen = new Set();
  const deals = [
    ...amazon.deals,
    ...flipkart.deals
  ].filter(d => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });

  cache = {
    updatedAt: new Date(now).toISOString(),
    source: 'Direct Amazon & Flipkart pages',
    amazon: storeBlock(amazon),
    flipkart: storeBlock(flipkart),
    total: deals.length
  };
  cachedAt = now;

  const payload = JSON.stringify(cache);
  await Promise.all([
    writeFile(cacheFile, payload).catch(() => {}),
    writeFile(stateFile, payload).catch(() => {})
  ]);

  for (const [name, s] of [['amazon', amazon], ['flipkart', flipkart]]) {
    console.log(`[deals] ${name}: fresh=${s.fresh} retained=${s.retained} expired=${s.expired} total=${s.total} status=${s.status}`);
  }
  console.log(`[deals] merged ${deals.length} deals at ${cache.updatedAt}`);
  return cache;
}

async function loadDeals(force = false) {
  if (!force && cache && Date.now() - cachedAt < refreshMs) return cache;
  // One shared in-flight scrape: overlapping requests cannot race and let a
  // slower, emptier result overwrite the cache.
  if (!inflight) inflight = scrapeDeals().finally(() => { inflight = null; });
  return inflight;
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
  
  if (url.pathname !== '/' && url.pathname !== '/index.html') {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  
  try {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(path.join(__dirname, 'public', 'index.html')));
  } catch {
    response.writeHead(500);
    response.end('Page could not be loaded.');
  }
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
