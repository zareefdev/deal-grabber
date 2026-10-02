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
 * Spotlight: the deepest live discount among flagship hardware. The picker and the
 * regexes are serialised into the page (id="spotlight-config") so the runtime
 * re-renders the exact same three picks from a fresh snapshot without shipping a
 * second copy of these patterns.
 */
export const HERO_MIN_PRICE = 50000;
export const SPOTLIGHT_ACCESSORY = /screen ?protector|tempered|glass|case\b|back ?cover|cover\b|charger|cable|adapter|power ?bank|holder|strap|sleeve|pouch|\bskin\b|\bbumper\b|\bmonitor\b|\bdock\b|\bhub\b|\bstand\b|\bkeyboard\b|\bmouse\b|compatible|for (macbook|iphone|samsung|galaxy)/i;
export const SPOTLIGHT_FAMILIES = [
  { tag: 'MacBook', test: /^(?=.*\bmacbook\b)(?=.*\bapple\b).*$/i },
  { tag: 'iPhone', test: /\biphone\b/i, prefer: /iphone\s?(1[0-9]|air|se|pro|plus)/i },
  {
    tag: 'Samsung Galaxy',
    test: /^(?=.*\bsamsung\b)(?=.*\bgalaxy\b)(?!.*\bgalaxy\s+(a|m|f)\d)(?!.*\btab\s+a\d).*$/i,
    prefer: /galaxy\s?(s\d{1,2}\b|z\b|z\s?(fold|flip)|note\b)|ultra|\btab\s?s\d/i,
    flagshipTag: 'Galaxy flagship'
  }
];

export function spotlightConfig() {
  return {
    minPrice: HERO_MIN_PRICE,
    accessory: SPOTLIGHT_ACCESSORY.source,
    families: SPOTLIGHT_FAMILIES.map(({ tag, test, prefer, flagshipTag }) => ({
      tag,
      test: test.source,
      ...(prefer ? { prefer: prefer.source } : {}),
      ...(flagshipTag ? { flagshipTag } : {})
    }))
  };
}

/** Picks one deal per flagship family, then tops up to three by raw discount. */
export function pickSpotlight(list) {
  const pool = list.filter(deal => deal.title && deal.url && dealPrice(deal) > HERO_MIN_PRICE && !SPOTLIGHT_ACCESSORY.test(deal.title));
  const used = new Set();
  const picks = [];
  for (const family of SPOTLIGHT_FAMILIES) {
    const test = new RegExp(family.test, 'i');
    const candidates = pool.filter(deal => !used.has(deal.id) && test.test(deal.title));
    if (!candidates.length) continue;
    const prefer = family.prefer ? new RegExp(family.prefer, 'i') : null;
    candidates.sort((a, b) => {
      if (prefer) {
        const pa = prefer.test(a.title) ? 1 : 0;
        const pb = prefer.test(b.title) ? 1 : 0;
        if (pb !== pa) return pb - pa;
      }
      return b.discount - a.discount;
    });
    const best = candidates[0];
    used.add(best.id);
    const isFlagship = prefer ? prefer.test(best.title) : false;
    picks.push({ tag: (family.flagshipTag && isFlagship) ? family.flagshipTag : family.tag, deal: best });
  }
  if (picks.length < 3) {
    pool.filter(deal => !used.has(deal.id))
      .sort((a, b) => b.discount - a.discount)
      .slice(0, 3 - picks.length)
      .forEach(deal => {
        used.add(deal.id);
        picks.push({ tag: deal.category || 'Electronics', deal });
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
