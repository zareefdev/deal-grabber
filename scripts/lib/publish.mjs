/**
 * Shared deal-publishing rules.
 *
 * The client (public/index.html), the scraper (server.js) and the static page
 * generator (scripts/build-pages.mjs) must all agree on which rows are visible,
 * otherwise the crawlable pages and the live grid would show different counts for
 * the same feed. Every rule the user has pinned down lives here once.
 */

export const MIN_DEAL_PRICE = Number(process.env.MIN_DEAL_PRICE || 1000);
export const MAX_DEALS = Number(process.env.MAX_DEALS || 500);
export const AMAZON_SHARE = 0.7;
export const AMAZON_TAG = 'mdzareef-21';

/**
 * How often to describe the refresh in user-facing copy, and how long the page
 * waits before re-reading the feed.
 *
 * The workflow asks for a 10-minute cron, but GitHub queues and delays scheduled runs under
 * load — measured across recent runs the real interval is 17–20 minutes. Claiming
 * "every 10 minutes" across ~78 places would be a false freshness statement, so
 * both the copy and the client poll use the honest interval. Raise this only if the
 * refresh moves to a scheduler with real minute-level guarantees.
 */
export const REFRESH_MINUTES = 20;

/** A page needs at least this many deals to be worth indexing on its own. */
export const MIN_PAGE_DEALS = 12;

export const CATEGORIES = [
  {
    key: 'Mobiles', slug: 'mobiles', title: 'Mobile Phone Deals', h1: 'Mobile phone deals',
    blurb: 'Smartphones across every budget — entry-level handsets, mid-range value kings and the latest flagships.',
    meta: 'Live mobile phone deals from Amazon.in and Flipkart — every listing in stock, over ₹1,000, refreshed throughout the day.'
  },
  {
    key: 'Laptops', slug: 'laptops', title: 'Laptop Deals', h1: 'Laptop deals',
    blurb: 'Notebooks for study, work and gaming, from thin-and-light ultrabooks to high-refresh gaming rigs.',
    meta: 'Live laptop deals from Amazon.in and Flipkart — student, office and gaming notebooks in stock, refreshed throughout the day.'
  },
  {
    key: 'Electronics', slug: 'electronics', title: 'Electronics Deals', h1: 'Electronics deals',
    blurb: 'Earbuds, smart watches, televisions, cameras and the everyday tech that quietly discounts the most.',
    meta: 'Live electronics deals from Amazon.in and Flipkart — earbuds, smart watches, TVs and cameras in stock, refreshed daily.'
  }
];

export const STORES = [
  { key: 'Amazon', slug: 'amazon', title: 'Amazon India Deals', h1: 'Amazon.in deals' },
  { key: 'Flipkart', slug: 'flipkart', title: 'Flipkart Deals', h1: 'Flipkart deals' }
];

/** Price bands, cheapest first. `test` must stay true for a deal to land in the band. */
export const PRICE_BANDS = [
  { slug: 'under-5000', title: 'Tech Deals Under ₹5,000', h1: 'Tech deals under ₹5,000', test: price => price < 5000 },
  { slug: 'under-10000', title: 'Tech Deals Under ₹10,000', h1: 'Tech deals under ₹10,000', test: price => price < 10000 },
  { slug: 'under-25000', title: 'Tech Deals Under ₹25,000', h1: 'Tech deals under ₹25,000', test: price => price < 25000 },
  { slug: 'over-50000', title: 'Premium Deals Above ₹50,000', h1: 'Premium deals above ₹50,000', test: price => price > 50000 }
];

export function dealPrice(deal) {
  const value = Number(String(deal?.price ?? '').replace(/[^\d]/g, ''));
  return Number.isFinite(value) ? value : 0;
}

/**
 * A real markdown is a modest multiple of the selling price. These rows sit at 100x
 * or 376x, which means the scraper paired a *variant's* price with a different
 * variant's MRP — a ₹1,299 kids camera listed against a ₹1,29,900 list price, for
 * instance. Publishing those as "99% off" would put a false claim in the markup and
 * in the Product/Offer JSON-LD, so a row this lopsided is treated as unverified and
 * its crossed-out price is dropped rather than shown.
 */
export const MAX_PLAUSIBLE_PRICE_RATIO = 15;

export function priceRatioIsPlausible(deal) {
  const price = dealPrice(deal);
  const was = dealPrice({ price: deal?.originalPrice });
  if (!price || !was || was <= price) return true;
  return was / price <= MAX_PLAUSIBLE_PRICE_RATIO;
}

/** Stale carries, out-of-stock rows and anything under the floor never get published. */
export function isPublishable(deal) {
  if (!deal || typeof deal !== 'object') return false;
  if (deal.stale) return false;
  if (deal.available === false) return false;
  if (!deal.title || !deal.url) return false;
  if (!priceRatioIsPlausible(deal)) return false;
  return dealPrice(deal) >= MIN_DEAL_PRICE;
}

/**
 * A row whose MRP could not be trusted still belongs in the feed — the price is real —
 * but it must not advertise a discount it cannot back up.
 */
export function sanitiseDeal(deal) {
  if (!deal || typeof deal !== 'object') return deal;
  if (priceRatioIsPlausible(deal)) return deal;
  const { originalPrice, discount, ...rest } = deal;
  return { ...rest, discount: 0, discountUnverified: true };
}

export function publishable(deals) {
  return (deals || []).filter(isPublishable).map(sanitiseDeal);
}

/** Tag every Amazon outbound link at render time, so even an untagged snapshot earns. */
export function affiliateUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (/(^|\.)amazon\./i.test(parsed.hostname)) parsed.searchParams.set('tag', AMAZON_TAG);
    return parsed.href;
  } catch {
    return url;
  }
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Weave the two stores against a 70/30 target instead of shuffling flat, so every
 * prefix of the feed holds the split rather than only the full list. Flipkart is
 * hard-capped at 30% and Amazon is never trimmed.
 */
export function mixStores(amazon, flipkart) {
  if (!amazon.length) return shuffle(flipkart);
  if (!flipkart.length) return shuffle(amazon);
  const maxFlipkart = Math.floor((amazon.length * (1 - AMAZON_SHARE)) / AMAZON_SHARE);
  const a = shuffle(amazon);
  const f = shuffle(flipkart).slice(0, maxFlipkart);
  const out = [];
  let ai = 0;
  let fi = 0;
  while (ai < a.length || fi < f.length) {
    const takeAmazon = fi >= f.length ? true : ai >= a.length ? false : (out.length + 1) * 7 - ai * 10 >= 5;
    out.push(takeAmazon ? a[ai++] : f[fi++]);
  }
  return out;
}

/**
 * The exact pool the grid renders: publishable rows, mixed 70/30, capped.
 * Static pages slice this same array, so their counts always match the live feed.
 */
export function feedFromSnapshot(snapshot) {
  const amazon = publishable(snapshot?.amazon?.deals);
  const flipkart = publishable(snapshot?.flipkart?.deals);
  return mixStores(amazon, flipkart).slice(0, MAX_DEALS);
}

/**
 * Spotlight: the flagship hero. Apple and Samsung are both guaranteed a slot, and
 * within each family the *deepest discount wins* — a 3%-off iPhone is not a "deep
 * cut", so the old name-first ranking put the dullest product in the hero.
 *
 * The picker and the regexes are serialised into the page (id="spotlight-config")
 * so the runtime re-renders the exact same picks from a fresh snapshot without
 * shipping a second copy of these patterns.
 */
export const HERO_MIN_PRICE = 50000;
export const HERO_SLOTS = 3;
export const SPOTLIGHT_ACCESSORY = /screen ?protector|tempered|glass|case\b|back ?cover|cover\b|charger|cable|adapter|power ?bank|holder|strap|sleeve|pouch|\bskin\b|\bbumper\b|\bmonitor\b|\bdock\b|\bhub\b|\bstand\b|\bkeyboard\b|\bmouse\b|compatible|for (macbook|iphone|samsung|galaxy)/i;

/**
 * Some scrapes return a bare brand word as the whole title ("Apple", "Samsung").
 * Those rows are real listings with a broken name, and a hero card reading
 * "Apple · ₹1,19,900" is nonsense, so they never get a slot.
 */
export const SPOTLIGHT_BARE_BRAND = /^(apple|samsung|google|redmi|oneplus|vivo|xiaomi|realme|oppo|nothing|motorola|nokia|honor|iqoo|asus|lenovo|dell|hp|acer|sony|jbl|boat|fire[-\s]?bolt|noise|lava|micromax|poco|tecno|infinix|nubia|casio|canon|nikon|garmin|fossil|fitbit|amazfit|realme|anker|boAt|mivi|zebronics|philips|titan|fastrack|wildcraft|nakshatra|beardo|beardo)\s*[0-9a-z+\-]{0,6}$/i;

/** Ranks by markdown, newest-first as the tiebreak so equal discounts stay stable. */
function deepestDiscount(a, b) {
  const da = Number(a.discount) || 0;
  const db = Number(b.discount) || 0;
  if (db !== da) return db - da;
  return dealPrice(b) - dealPrice(a);
}

/** Apple and Samsung, the two brands the hero is required to show. */
export const SPOTLIGHT_FAMILIES = [
  {
    tag: 'Apple',
    test: /\b(macbook|iphone|ipad|apple)\b/i,
    // Prefer the halo names so a MacBook never loses the slot to an accessory.
    prefer: /\b(macbook|iphone\s?(1[0-9]\b|air|se|pro|plus))\b/i,
    flagshipTag: 'Apple flagship'
  },
  {
    tag: 'Samsung',
    test: /\b(samsung|galaxy)\b/i,
    prefer: /\b(galaxy\s?(s\d{1,2}\b|z\b|note\b)|galaxy\s?z\s?(fold|flip)|ultra|macbook|book\d)\b/i,
    flagshipTag: 'Samsung Galaxy'
  }
];

/**
 * A readable brand for the third hero slot. A category name ("Laptops") reads as a
 * section header rather than a product brand, so prefer a name lifted off the title.
 */
const SPOTLIGHT_BRANDS = [
  { tag: 'Apple', test: /\b(apple|macbook|iphone|ipad)\b/i },
  { tag: 'Samsung', test: /\b(samsung|galaxy)\b/i },
  { tag: 'OnePlus', test: /\bone\s?plus\b/i },
  { tag: 'Xiaomi', test: /\b(xiaomi|redmi|poco|mi\s?\d|note\s?\d)\b/i },
  { tag: 'Google', test: /\b(pixel|google)\b/i },
  { tag: 'Realme', test: /\brealme\b/i },
  { tag: 'Vivo', test: /\b(vivo|iQOO)\b/i },
  { tag: 'Nothing', test: /\bnothing\b/i },
  { tag: 'Motorola', test: /\bmotorola\b/i },
  { tag: 'Lenovo', test: /\b(lenovo|thinkpad|ideapad|legion)\b/i },
  { tag: 'Dell', test: /\b(dell|xps|inspiron|alienware|lattitude)\b/i },
  { tag: 'HP', test: /\b(hp\b|pavilion|omen|envy|elite ?book)/i },
  { tag: 'Asus', test: /\b(asus|rog\b|zenbook|vivo ?book)\b/i },
  { tag: 'Acer', test: /\bacer\b/i },
  { tag: 'Sony', test: /\b(sony|bravia|wh-\d)/i },
  { tag: 'JBL', test: /\bjbl\b/i }
];

function brandTag(title, fallback) {
  for (const brand of SPOTLIGHT_BRANDS) {
    if (brand.test.test(title)) return brand.tag;
  }
  return fallback || 'Electronics';
}

export function spotlightConfig() {
  return {
    minPrice: HERO_MIN_PRICE,
    slots: HERO_SLOTS,
    accessory: SPOTLIGHT_ACCESSORY.source,
    bareBrand: SPOTLIGHT_BARE_BRAND.source,
    brands: SPOTLIGHT_BRANDS.map(({ tag, test }) => ({ tag, test: test.source })),
    families: SPOTLIGHT_FAMILIES.map(({ tag, test, prefer, flagshipTag }) => ({
      tag,
      test: test.source,
      ...(prefer ? { prefer: prefer.source } : {}),
      ...(flagshipTag ? { flagshipTag } : {})
    }))
  };
}

/** Product name without colour/storage tails, so variants cannot double up in the hero. */
function baseProduct(title) {
  return String(title || '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\b\d+\s*(gb|tb|mb)\b/gi, '')
    .replace(/\b\d{4}\s*model\b/gi, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function heroCandidate(deal) {
  return deal
    && deal.title
    && deal.url
    && dealPrice(deal) > HERO_MIN_PRICE
    && !SPOTLIGHT_ACCESSORY.test(deal.title)
    && !SPOTLIGHT_BARE_BRAND.test(deal.title.trim());
}

/**
 * One slot per brand, chosen by discount, then a third slot filled by the deepest
 * remaining flagship so the hero still shows three products on a thin snapshot.
 */
export function pickSpotlight(list) {
  const pool = (list || []).filter(heroCandidate);
  const used = new Set();
  const bases = new Set();
  const picks = [];

  for (const family of SPOTLIGHT_FAMILIES) {
    const test = new RegExp(family.test, 'i');
    const prefer = family.prefer ? new RegExp(family.prefer, 'i') : null;
    const candidates = pool.filter(deal => !used.has(deal.id) && test.test(deal.title));

    // Discount first; the halo-name regex only separates rows that tie on markdown,
    // so it can never promote a 3%-off iPhone over a genuinely reduced MacBook.
    const best = candidates.slice().sort((a, b) => {
      const byDiscount = deepestDiscount(a, b);
      if (byDiscount) return byDiscount;
      if (prefer) {
        const pa = prefer.test(a.title) ? 1 : 0;
        const pb = prefer.test(b.title) ? 1 : 0;
        if (pb !== pa) return pb - pa;
      }
      return 0;
    })[0];

    if (!best) continue;
    used.add(best.id);
    bases.add(baseProduct(best.title));
    const isFlagship = prefer ? prefer.test(best.title) : false;
    picks.push({ tag: (family.flagshipTag && isFlagship) ? family.flagshipTag : family.tag, deal: best });
  }

  if (picks.length < HERO_SLOTS) {
    pool
      .filter(deal => !used.has(deal.id) && !bases.has(baseProduct(deal.title)))
      .sort(deepestDiscount)
      .slice(0, HERO_SLOTS - picks.length)
      .forEach(deal => {
        used.add(deal.id);
        bases.add(baseProduct(deal.title));
        picks.push({ tag: brandTag(deal.title, deal.category), deal });
      });
  }

  return picks;
}

/**
 * Colour and storage variants arrive as separate listings, so sorting a slice by raw
 * discount stacks eight near-identical cards of the same phone. Collapse each product
 * to one entry, keeping the cheapest variant — that is the one worth linking to.
 *
 * Landing pages only. The live grid deliberately renders every row so the store badges
 * keep matching the pool size.
 */
export function dedupeVariants(deals) {
  const seen = new Map();
  for (const deal of deals) {
    // "Galaxy S21 FE 5G (Olive, 128 GB)" and "Galaxy S21 FE 5G (Navy, 256 GB)"
    // must collapse to one key, so strip variant clauses before comparing.
    const base = String(deal.title || '')
      .replace(/\s*\([^)]*\)\s*$/g, '')
      .replace(/\b\d+\s*(gb|tb|mb)\b/gi, '')
      .replace(/\b(black|white|silver|gold|blue|green|red|pink|purple|grey|gray|navy|olive|teal|lavender|cream|graphite|starlight|titanium|midnight|azure|space grey)\b/gi, '')
      .replace(/\b\d{4}\s*model\b/gi, '')
      .replace(/[^a-z0-9]+/gi, ' ')
      .trim()
      .toLowerCase();
    if (!base) continue;
    const keep = seen.get(base);
    if (!keep || dealPrice(deal) < dealPrice(keep)) seen.set(base, deal);
  }
  return [...seen.values()];
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** ₹ with Indian digit grouping: 1234567 -> ₹12,34,567 */
export function formatRupees(value) {
  const price = dealPrice({ price: value });
  return `₹${price.toLocaleString('en-IN')}`;
}

export function discountLabel(deal) {
  return deal.discount ? `${Math.round(deal.discount)}% off` : '';
}
