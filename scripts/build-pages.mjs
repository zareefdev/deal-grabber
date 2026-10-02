#!/usr/bin/env node
/**
 * Generates the crawlable landing pages from the scraped snapshot.
 *
 * The live homepage renders its grid with JavaScript, which means a crawler sees an
 * empty page. These pages close that gap: one static, fully-linked page per category,
 * store and price band, each with real cards in the HTML and an ItemList in the JSON-LD.
 *
 * Pages are cut from the same publishable pool the live feed uses (fresh, in-stock,
 * >= MIN_DEAL_PRICE, capped at MAX_DEALS, mixed 70/30), so a count on a landing page
 * always matches what the feed shows for the same slice.
 *
 * Usage: node scripts/build-pages.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AMAZON_SHARE, CATEGORIES, MAX_DEALS, MIN_DEAL_PRICE, MIN_PAGE_DEALS, PRICE_BANDS, STORES,
  affiliateUrl, dealPrice, dedupeVariants, escapeHtml, feedFromSnapshot, formatRupees,
  pickSpotlight, publishable, spotlightConfig
} from './lib/publish.mjs';
import {
  BASE_CSS, REFRESH_MINUTES, SITE_NAME, SITE_URL, TOKENS,
  renderDealCard, renderDisclosure, renderFooter, renderHead, renderNav, renderStats
} from './lib/render.mjs';
import { HOMEPAGE_RUNTIME } from './lib/runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SNAPSHOT = path.join(PUBLIC_DIR, 'deals.json');

/** Cards baked into a landing page. Beyond this the HTML stops being worth the bytes. */
const MAX_CARDS_PER_PAGE = 60;

/** Homepage-only CSS: the live controls, flagship spotlight and the opt-in card. */
const HOME_CSS = `
.controls{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:0 0 12px}
.controls h2{margin:0;font-family:var(--font-display);font-size:clamp(19px,2.6vw,25px);font-weight:700;letter-spacing:-.04em}
.toolbar{display:grid;gap:11px;margin:0 0 24px;padding:16px 18px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
.search{min-height:46px;padding:0 14px;border:1px solid var(--line);border-radius:11px;background:var(--paper);font-size:14px}
.search:focus{border-color:var(--lime-deep)}
.toolbar-actions{display:flex;flex-wrap:wrap;gap:8px}
.refresh,.pause{min-height:44px;padding:0 15px;border:1px solid var(--ink);border-radius:11px;background:var(--ink);color:#fff;font-size:13px;font-weight:700;cursor:pointer}
.pause{border-color:var(--line);background:var(--surface);color:var(--muted)}
.refresh:disabled{opacity:.55;cursor:default}
.refresh-meta{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 16px;color:var(--muted-2);font-size:11.5px}
.status{display:inline-flex;align-items:center;gap:7px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--muted-2)}
.dot.live{background:#3f9c2f}
.dot.partial{background:#c08a1e}
.dot.error{background:#c2453a}
.filters{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 14px}

.spotlight{margin:26px 0 0;padding:18px 18px 20px;border-radius:20px;background:linear-gradient(150deg,#1d2a23,#101a15);color:#e7eee8}
.spotlight[hidden]{display:none}
.spotlight-title{margin:0;font-family:var(--font-display);font-size:clamp(17px,2.2vw,20px);font-weight:700;letter-spacing:-.04em}
.spotlight-note{margin:5px 0 0;color:#93a199;font-size:11.5px;line-height:1.5}
.spotlight-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:15px}
.hero-card{display:flex;flex-direction:column;gap:11px;padding:12px;border:1px solid #2b3831;border-radius:15px;background:#1e2a23;color:inherit;text-decoration:none;transition:transform .18s ease,border-color .18s ease}
.hero-card:hover{transform:translateY(-3px);border-color:var(--lime)}
.hero-media{position:relative;display:grid;place-items:center;aspect-ratio:4/3;border-radius:11px;background:#fff;overflow:hidden}
.hero-media img{width:100%;height:100%;object-fit:contain;mix-blend-mode:multiply}
.hero-media .image-fallback,.image-fallback{display:grid;place-items:center;height:100%;color:#a5aaa2;font-size:12px}
.hero-info{display:flex;flex:1;flex-direction:column;gap:7px}
.hero-tag{align-self:flex-start;padding:3px 8px;border-radius:99px;background:var(--lime);color:var(--lime-ink);font-size:9.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}
.hero-info h3{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;min-height:2.6em;margin:0;font-size:12.5px;line-height:1.35;font-weight:600}
.hero-price{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px;margin-top:auto}
.hero-now{font-family:var(--font-display);font-size:18px;font-weight:700;letter-spacing:-.035em}
.hero-was{color:#93a199;font-size:11px;text-decoration:line-through}
.hero-off{padding:3px 7px;border-radius:6px;background:rgba(200,242,108,.16);color:var(--lime);font-size:10.5px;font-weight:800;white-space:nowrap}
.hero-cta{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:8px;border-top:1px solid #2b3831;color:#c2cfc6;font-size:11px;font-weight:700}

.alerts{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px 22px;margin:0 0 26px;padding:17px 19px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
.alerts[hidden]{display:none}
.alerts-text{max-width:560px}
.alerts-text h2{margin:6px 0;font-family:var(--font-display);font-size:clamp(17px,2.3vw,21px);font-weight:700;letter-spacing:-.035em}
.alerts-text p{margin:0;color:var(--muted);font-size:12px;line-height:1.55}
.alerts-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.alerts-btn{min-height:44px;padding:0 16px;border:1px solid var(--lime-deep);border-radius:11px;background:var(--lime);color:var(--lime-ink);font-size:13px;font-weight:700;cursor:pointer}
.alerts-btn.ghost{border-color:var(--line);background:var(--surface);color:var(--muted)}
.alerts-btn:disabled{opacity:.55;cursor:default}
.alerts-state{flex-basis:100%;color:var(--muted);font-size:11px}

.hero h1 span{color:var(--lime-deep)}
@media (max-width:850px){.spotlight-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:600px){
  .spotlight{padding:14px;border-radius:17px}
  .spotlight-grid{grid-template-columns:1fr;gap:9px;margin-top:13px}
  /* Row layout: image left, price and CTA on one line, so three flagships fit
     a phone screen without the title wrapping into a paragraph. */
  .hero-card{flex-direction:row;align-items:center;gap:11px;padding:10px}
  .hero-media{flex:0 0 88px;width:88px;aspect-ratio:1}
  .hero-info{gap:4px}
  .hero-info h3{-webkit-line-clamp:2;min-height:0;font-size:12px}
  .hero-tag{font-size:9px;padding:2px 7px}
  .hero-now{font-size:16px}
  .hero-was{font-size:10.5px}
  .hero-off{font-size:10px}
  .hero-cta{padding-top:6px;font-size:10.5px}
  .alerts{padding:14px}
  .alerts-btn{flex:1 1 auto}
}
`.trim();

/** Every slug this generator owns. Deleting exactly this set keeps stale pages out. */
const OWNED_SLUGS = [
  ...CATEGORIES.map(c => c.slug),
  ...STORES.map(s => s.slug),
  ...PRICE_BANDS.map(p => p.slug)
];

// FAQ entries are plain {name, answer} records. Both consumers — the visible <dl> and
// the FAQPage schema — read that shape, so a question can never end up with an empty
// answer in one place and a filled one in the other. (They used to be pre-shaped
// schema nodes, which the {name, answer} readers silently turned into blank <dd>s and
// blank acceptedAnswer.text.)
const AFFILIATE_FAQ = {
  name: 'Is this site affiliated with Amazon or Flipkart?',
  answer: 'No. It is an independent tracker that only reads publicly visible listings and links back to the stores. It takes part in the Amazon Associates programme, so some links are affiliate links and we may earn a commission from qualifying purchases, at no extra cost to you. It never changes the price you pay.'
};

const FRESHNESS_FAQ = {
  name: 'How often are these deals updated?',
  answer: `A scheduled job re-reads Amazon.in and Flipkart and republishes the feed roughly every ${REFRESH_MINUTES} minutes. Anything that leaves the stores ages out, so expired listings drop off on their own.`
};

const PRICE_FAQ = {
  name: 'Are the prices guaranteed?',
  answer: 'No. Prices, stock and offers change without notice, so always confirm the final amount at checkout on Amazon.in or Flipkart.'
};

/** FAQPage node built from the {name, answer} records, so schema and page always agree. */
function faqSchemaNode(faq, path) {
  return {
    '@type': 'FAQPage',
    '@id': `${SITE_URL}${path}#faq`,
    mainEntity: faq.map(item => ({
      '@type': 'Question',
      name: item.name,
      acceptedAnswer: { '@type': 'Answer', text: item.answer }
    }))
  };
}

/** The visible <dl>. Google only credits FAQPage markup whose answers are on the page. */
function faqHtmlBlock(faq, heading = 'Frequently asked questions') {
  if (!faq || !faq.length) return '';
  return `<h3>${escapeHtml(heading)}</h3>
<dl>${faq.map(item => `<dt>${escapeHtml(item.name)}</dt><dd>${escapeHtml(item.answer)}</dd>`).join('')}</dl>`;
}

// The homepage names the site in its affiliate answer and promises the same
// behaviour as the landing pages, so both the visible <dl> and the FAQPage schema
// are generated from this one list.
const homeFaq = () => [
  {
    name: `Is ${SITE_NAME} affiliated with Amazon or Flipkart?`,
    answer: 'No. It is an independent tracker that only reads publicly visible listings and links back to the stores. It takes part in the Amazon Associates programme, so some links are affiliate links and we may earn a commission from qualifying purchases — at no extra cost to you, and it never changes the price you pay.'
  },
  PRICE_FAQ,
  {
    name: 'How often is the deal feed updated?',
    answer: 'Throughout the day on a scheduled refresh. Each rebuild drops out-of-stock and expired listings and re-reads both stores, so the page never shows a dead deal.'
  }
];

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT)) {
    console.warn('[pages] no deals.json yet — skipping build');
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  } catch (error) {
    console.warn(`[pages] deals.json is unreadable (${error.message}) — skipping build`);
    return null;
  }
}

/** Cheapest / median / most expensive, used for the price-band pages and the stats strip. */
function priceStats(deals) {
  if (!deals.length) return { min: 0, max: 0, median: 0, avgOff: 0 };
  const prices = deals.map(dealPrice).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2);
  const avgOff = deals.reduce((sum, d) => sum + (Number(d.discount) || 0), 0) / deals.length;
  return { min: prices[0], max: prices[prices.length - 1], median, avgOff: Math.round(avgOff) };
}

/** Links out to the other landing pages, so the generated set is fully interlinked. */
function siblingLinks(currentSlug, pool) {
  const pages = [
    ...CATEGORIES.map(c => ({ href: `/${c.slug}/`, label: c.h1, test: d => d.category === c.key })),
    ...STORES.map(s => ({ href: `/${s.slug}/`, label: s.h1, test: d => d.store === s.key })),
    ...PRICE_BANDS.map(b => ({ href: `/${b.slug}/`, label: b.h1, test: d => b.test(dealPrice(d)) }))
  ];
  return pages
    .filter(page => page.href !== `/${currentSlug}/`)
    .map(page => {
      const count = pool.filter(page.test).length;
      return { ...page, count };
    })
    .filter(page => page.count >= MIN_PAGE_DEALS)
    .sort((a, b) => b.count - a.count);
}

function breadcrumbSchema(trail) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.label,
      item: `${SITE_URL}${crumb.href}`
    }))
  };
}

function itemListSchema(name, description, deals, path) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${SITE_URL}${path}#deals`,
    name,
    description,
    numberOfItems: deals.length,
    itemListOrder: 'https://schema.org/ItemListOrderDescending',
    itemListElement: deals.map((deal, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: {
        '@type': 'Product',
        name: deal.title,
        url: deal.url,
        ...(deal.image ? { image: deal.image } : {}),
        offers: {
          '@type': 'Offer',
          price: String(dealPrice(deal)),
          priceCurrency: 'INR',
          availability: 'https://schema.org/InStock',
          url: deal.url
        }
      }
    }))
  };
}

/**
 * Renders one landing page. `spec` describes the slice; `deals` is already filtered
 * to publishable rows from the mixed feed.
 */
function renderPage(spec, deals, snapshotDate) {
  const { slug, title, h1, description, lede, crumbs, breadcrumbTrail, stats, extraProse, faq } = spec;
  const path = `/${slug}/`;

  // Collapse colour/storage variants: a raw sort by discount stacks eight cards of
  // the same phone, which reads as spam to both a visitor and a crawler.
  const distinct = dedupeVariants(deals);
  const ranked = distinct.slice().sort((a, b) => (b.discount || 0) - (a.discount || 0));
  const shown = ranked.slice(0, MAX_CARDS_PER_PAGE);
  const truncated = ranked.length > shown.length;

  const statsHtml = renderStats(stats);
  const cards = shown.length
    ? shown.map(renderDealCard).join('\n')
    : `<div class="state"><h3>No matching deals right now</h3><p>This slice is empty in the current snapshot. The full feed refreshes every ${REFRESH_MINUTES} minutes — check the <a href="/">all deals page</a> for what is live today.</p></div>`;

  // Counts must describe what is actually on the page, so a heading never claims more
  // listings than the cards below it.
  const summary = truncated
    ? `Showing the ${shown.length} deepest discounts of <strong>${ranked.length}</strong> distinct ${ranked.length === 1 ? 'product' : 'products'} in this category.`
    : `<strong>${ranked.length}</strong> distinct ${ranked.length === 1 ? 'product' : 'products'} in this category, all in stock right now.`;

  const links = siblingLinks(slug, deals);
  const linkChips = links.map(link =>
    `<a class="chip" href="${link.href}">${escapeHtml(link.label)} <span class="chip-n">${link.count}</span></a>`
  ).join('\n');

  // The trail must end at the current page exactly once. It used to append the h1
  // on top of a trail whose last entry was already that same page, so every landing
  // page read "Home / Mobile Phone Deals / Mobile phone deals".
  const trail = breadcrumbTrail || [];
  const lastLabel = (trail.length ? trail[trail.length - 1].label : '').trim();
  const endsHere = lastLabel.toLowerCase() === h1.trim().toLowerCase();
  const breadcrumbHtml = `<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li>${trail.map((c, i) => {
    const isLast = i === trail.length - 1;
    return (isLast && endsHere)
      ? `<li aria-current="page">${escapeHtml(c.label)}</li>`
      : `<li><a href="${c.href}">${escapeHtml(c.label)}</a></li>`;
  }).join('')}${endsHere ? '' : `<li aria-current="page">${escapeHtml(h1)}</li>`}</ol></nav>`;

  const storeSplit = ['Amazon', 'Flipkart'].map(store => {
    const count = deals.filter(d => d.store === store).length;
    return `<tr><td>${escapeHtml(store)}</td><td>${count}</td><td>${deals.length ? Math.round((count / deals.length) * 100) : 0}%</td></tr>`;
  }).join('');

  // Google only honours FAQPage markup whose answers are visible on the page, so
  // this block has to ship alongside the schema below rather than be built and dropped.
  const faqHtml = faqHtmlBlock(faq);

  const proseHtml = `
<section class="prose" aria-labelledby="about-${slug}">
<h2 id="about-${slug}">${escapeHtml(h1)} on ${escapeHtml(SITE_NAME)}</h2>
<p>${escapeHtml(lede)}</p>
${extraProse}
<h3>Store split right now</h3>
<table><thead><tr><th>Store</th><th>Live deals</th><th>Share</th></tr></thead><tbody>${storeSplit}</tbody></table>
<p>Snapshot built ${escapeHtml(snapshotDate)}. Prices, stock and offers change without notice — always confirm the final amount at checkout.</p>
${faqHtml}
</section>`;

  const schema = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${SITE_URL}${path}#webpage`,
        url: `${SITE_URL}${path}`,
        name: title,
        description,
        isPartOf: { '@id': `${SITE_URL}/#website` },
        breadcrumb: { '@id': `${SITE_URL}${path}#breadcrumb` },
        primaryImageOfPage: `${SITE_URL}/og-image.png`,
        inLanguage: 'en-IN'
      },
      breadcrumbSchema(breadcrumbTrail),
      itemListSchema(`${h1} — live deals`, description, shown, path),
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        url: `${SITE_URL}/`,
        name: SITE_NAME,
        description: `Live tech deals from Amazon.in and Flipkart in one place, refreshed every ${REFRESH_MINUTES} minutes.`,
        inLanguage: 'en-IN',
        publisher: { '@id': `${SITE_URL}/#org` }
      },
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#org`,
        name: SITE_NAME,
        url: `${SITE_URL}/`,
        logo: { '@type': 'ImageObject', url: `${SITE_URL}/og-image.png`, width: 1200, height: 630 }
      },
      ...(faq && faq.length ? [faqSchemaNode(faq, path)] : [])
    ]
  };

  return `<!doctype html>
<html lang="en-IN">
<head>
${renderHead({ title, description, path })}
<script type="application/ld+json">
${JSON.stringify(schema)}
</script>
<style>
${TOKENS}
${BASE_CSS}
</style>
</head>
<body>
${renderNav(path)}
<main class="wrap" id="main">
${breadcrumbHtml}
<section class="hero" aria-labelledby="page-title">
<p class="eyebrow">${escapeHtml(spec.eyebrow || 'Live tech deals')}</p>
<h1 id="page-title">${escapeHtml(h1)}</h1>
<p class="lede">${escapeHtml(description)}</p>
</section>
${statsHtml}
<p class="summary">${summary}</p>
<div class="deal-grid">${cards}</div>
${renderDisclosure()}
${links.length ? `<nav class="chipbar" aria-label="Related deal categories">${linkChips}</nav>` : ''}
${proseHtml}
<section class="cta-band" aria-labelledby="cta-${slug}">
<div><h2 id="cta-${slug}">Want the two best deals each morning?</h2><p>Allow notifications and we will send a short digest of the sharpest Amazon &amp; Flipkart discounts once a day. No account, no spam.</p></div>
<a href="/#alerts">Get deal alerts</a>
</section>
</main>
${renderFooter()}
</body>
</html>
`;
}

/** Wipes the directories this generator owns so a dropped slice cannot linger. */
function cleanOwnedPages() {
  for (const slug of OWNED_SLUGS) {
    const dir = path.join(PUBLIC_DIR, slug);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[pages] removed stale /${slug}/`);
    }
  }
}

function writePage(slug, html) {
  const dir = path.join(PUBLIC_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
}

function buildCategoryPages(feed, snapshotDate) {
  const written = [];
  for (const category of CATEGORIES) {
    const deals = feed.filter(deal => deal.category === category.key);
    if (deals.length < MIN_PAGE_DEALS) {
      console.log(`[pages] skipped /${category.slug}/ — only ${deals.length} deals`);
      continue;
    }
    const p = priceStats(deals);
    const cheapest = deals.slice().sort((a, b) => dealPrice(a) - dealPrice(b))[0];
    writePage(category.slug, renderPage({
      slug: category.slug,
      title: `${category.title} — ${deals.length} Live Deals Today`,
      h1: category.h1,
      eyebrow: `${category.key} · ${deals.length} live deals`,
      description: category.meta,
      lede: `${category.blurb} Every listing below is a fresh, in-stock deal pulled from Amazon.in and Flipkart — expired ones are dropped automatically, so what you see is still buyable.`,
      crumbs: [category.title],
      breadcrumbTrail: [{ label: category.title, href: `/${category.slug}/` }],
      stats: [
        ['Live deals', String(deals.length)],
        ['From', formatRupees(p.min)],
        ['Median price', formatRupees(p.median)],
        ['Avg. discount', `${p.avgOff}%`]
      ],
      extraProse: `<h3>How we pick these</h3>
<ul>
<li><strong>Fresh only.</strong> Anything a store has dropped is removed, so expired listings never send you to a dead page.</li>
<li><strong>In stock, over ₹1,000.</strong> Sub-₹1,000 accessories are filtered out to keep the signal high.</li>
<li><strong>Both stores, one page.</strong> ${deals.filter(d => d.store === 'Amazon').length} from Amazon.in and ${deals.filter(d => d.store === 'Flipkart').length} from Flipkart, mixed so you see both.</li>
<li><strong>Rebuilt every ${REFRESH_MINUTES} minutes.</strong> The snapshot this page is built from is dated ${escapeHtml(snapshotDate)}.</li>
</ul>`,
      faq: [
        { name: `Are these ${category.key.toLowerCase()} deals still available?`, answer: `They were in stock at the time this page was built on ${snapshotDate}. Stock moves quickly on deal pages, so confirm availability and the final price on the store before you buy.` },
        { ...FRESHNESS_FAQ, name: `How often are ${category.key.toLowerCase()} deals updated?` },
        AFFILIATE_FAQ
      ]
    }, deals, snapshotDate));
    written.push({ slug: category.slug, href: `/${category.slug}/`, priority: '0.9', count: deals.length, title: category.title });
    console.log(`[pages] /${category.slug}/ — ${deals.length} deals (from ${formatRupees(p.min)}, cheapest: ${(cheapest?.title || '').slice(0, 40)})`);
  }
  return written;
}

function buildStorePages(feed, snapshotDate) {
  const written = [];
  for (const store of STORES) {
    const deals = feed.filter(deal => deal.store === store.key);
    if (deals.length < MIN_PAGE_DEALS) {
      console.log(`[pages] skipped /${store.slug}/ — only ${deals.length} deals`);
      continue;
    }
    const p = priceStats(deals);
    const categories = CATEGORIES.map(c => [c.key, deals.filter(d => d.category === c.key).length]).filter(([, n]) => n > 0);
    const catRows = categories.map(([key, n]) => `<tr><td><a href="/${CATEGORIES.find(c => c.key === key).slug}/">${escapeHtml(key)}</a></td><td>${n}</td></tr>`).join('');
    const host = store.key === 'Amazon' ? 'www.amazon.in' : 'www.flipkart.com';

    writePage(store.slug, renderPage({
      slug: store.slug,
      title: `${store.title} — ${deals.length} Live Discounts Today`,
      h1: store.h1,
      eyebrow: `${store.key}.in · ${deals.length} live deals`,
      description: `${deals.length} live ${store.key} deals on ${store.key === 'Amazon' ? 'Amazon.in' : 'Flipkart'} — phones, laptops and electronics, filtered to fresh in-stock discounts and refreshed every ${REFRESH_MINUTES} minutes.`,
      lede: `Every ${store.key === 'Amazon' ? 'Amazon' : 'Flipkart'} deal on this page was read from a public ${host} deal listing in the last ${REFRESH_MINUTES} minutes. Out-of-stock and expired rows are removed before publishing, so the count here is what is actually live.`,
      crumbs: [store.title],
      breadcrumbTrail: [{ label: store.title, href: `/${store.slug}/` }],
      stats: [
        ['Live deals', String(deals.length)],
        ['From', formatRupees(p.min)],
        ['Biggest drop', `${Math.max(...deals.map(d => Number(d.discount) || 0))}%`],
        ['Avg. discount', `${p.avgOff}%`]
      ],
      extraProse: `<h3>${escapeHtml(store.key)} deals by category</h3>
<table><thead><tr><th>Category</th><th>Live deals</th></tr></thead><tbody>${catRows}</tbody></table>
<h3>How this list stays honest</h3>
<ul>
<li>Each row was seen on a public ${host} deal page within the last ${REFRESH_MINUTES} minutes.</li>
<li>Rows priced under ₹1,000 or marked unavailable are dropped before this page is built.</li>
<li>Price, stock and seller are all re-checked at checkout — the store is always the source of truth.</li>
</ul>`,
      faq: [
        { name: `How does ${SITE_NAME} find ${store.key} deals?`, answer: `It reads publicly listed ${host} deal pages, then keeps only rows that are in stock, priced above ₹1,000 and seen within the last ${REFRESH_MINUTES} minutes. Nothing is fetched from a private account or a logged-in session.` },
        { ...FRESHNESS_FAQ, name: `How often are ${store.key} deals updated?` },
        AFFILIATE_FAQ
      ]
    }, deals, snapshotDate));
    written.push({ slug: store.slug, href: `/${store.slug}/`, priority: '0.9', count: deals.length, title: store.title });
    console.log(`[pages] /${store.slug}/ — ${deals.length} deals (avg ${p.avgOff}% off)`);
  }
  return written;
}

function buildPricePages(feed, snapshotDate) {
  const written = [];
  for (const band of PRICE_BANDS) {
    const deals = feed.filter(deal => band.test(dealPrice(deal)));
    if (deals.length < MIN_PAGE_DEALS) {
      console.log(`[pages] skipped /${band.slug}/ — only ${deals.length} deals`);
      continue;
    }
    const p = priceStats(deals);
    const stores = ['Amazon', 'Flipkart'].map(s => [s, deals.filter(d => d.store === s).length]).filter(([, n]) => n > 0);
    const storeRows = stores.map(([s, n]) => `<tr><td>${escapeHtml(s)}</td><td>${n}</td></tr>`).join('');

    writePage(band.slug, renderPage({
      slug: band.slug,
      title: `${band.title} — ${deals.length} Live Deals`,
      h1: band.h1,
      eyebrow: `${deals.length} live deals`,
      description: `${deals.length} live tech deals ${band.h1.replace(/^Tech deals |^Premium deals /, '').toLowerCase()} from Amazon.in and Flipkart, refreshed every ${REFRESH_MINUTES} minutes.`,
      lede: `A price-banded view of the live feed: ${deals.length} in-stock deals that fall inside this range, sorted by the size of the discount. Prices and stock change constantly, so confirm at the store.`,
      crumbs: [band.title],
      breadcrumbTrail: [{ label: band.title, href: `/${band.slug}/` }],
      stats: [
        ['Live deals', String(deals.length)],
        ['Cheapest', formatRupees(p.min)],
        ['Priciest', formatRupees(p.max)],
        ['Avg. discount', `${p.avgOff}%`]
      ],
      extraProse: `<h3>Where these come from</h3>
<table><thead><tr><th>Store</th><th>Live deals in range</th></tr></thead><tbody>${storeRows}</tbody></table>
<p>Want the full picture rather than one price band? <a href="/">Browse every live deal</a>, or jump to a category: ${CATEGORIES.map(c => `<a href="/${c.slug}/">${escapeHtml(c.key)}</a>`).join(', ')}.</p>`,
      faq: [
        { name: `What counts as a deal under this price?`, answer: `Any in-stock Amazon.in or Flipkart listing priced inside this range that was seen in a public deal page within the last ${REFRESH_MINUTES} minutes and is listed above ₹1,000. Everything below ₹1,000 is filtered out as too small to be a meaningful discount.` },
        { ...FRESHNESS_FAQ, name: 'How often are these price-band deals updated?' },
        AFFILIATE_FAQ
      ]
    }, deals, snapshotDate));
    written.push({ slug: band.slug, href: `/${band.slug}/`, priority: band.slug === 'under-10000' ? '0.9' : '0.8', count: deals.length, title: band.title });
    console.log(`[pages] /${band.slug}/ — ${deals.length} deals (${formatRupees(p.min)}–${formatRupees(p.max)})`);
  }
  return written;
}

/**
 * The homepage, built from the same pool as every landing page.
 *
 * This is the page that matters most for search, and it used to ship with zero
 * cards: the grid and the ItemList were injected by JavaScript that a crawler
 * never runs. Baking the real cards in means the live feed and the indexed page
 * are the same markup, and the runtime only swaps the contents on refresh.
 *
 * The runtime hooks (toolbar, spotlight, alerts) are rendered server-side with
 * their current markup, then replaced by the feed script once deals load.
 */
function buildHomePage(feed, snapshotDate) {
  const ranked = feed.slice().sort((a, b) => (b.discount || 0) - (a.discount || 0));
  const shown = ranked.slice(0, MAX_CARDS_PER_PAGE);
  const amazon = feed.filter(d => d.store === 'Amazon').length;
  const flipkart = feed.length - amazon;
  const stats = priceStats(feed);
  const cheapest = ranked.length ? ranked[ranked.length - 1] : null;

  const title = `${SITE_NAME} — Live Amazon & Flipkart Deals`;
  const description = `Live tech deals from Amazon.in and Flipkart on one page — ${feed.length} phones, laptops, earbuds and TVs in stock right now, from ${formatRupees(stats.min)}. Rebuilt throughout the day.`;
  // SERPs truncate near 60 characters, and SITE_NAME already contains both store
  // names, so repeating them after the dash only wastes the visible part of the title.
  const seoTitle = `${SITE_NAME} — ${feed.length} Live Deals`;

  const cards = shown.length
    ? shown.map(renderDealCard).join('\n')
    : '<div class="state"><h3>The feed is rebuilding</h3><p>No listings in this snapshot yet. Try refreshing in a moment.</p></div>';

  const spotlight = pickSpotlight(feed)
    .map(({ tag, deal }) => `<a class="hero-card" href="${escapeHtml(affiliateUrl(deal.url))}" target="_blank" rel="sponsored noopener noreferrer">
<div class="hero-media">${deal.image ? `<img src="${escapeHtml(deal.image)}" alt="${escapeHtml(deal.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<span class="image-fallback">Image unavailable</span>'}</div>
<div class="hero-info"><span class="hero-tag">${escapeHtml(tag)}</span><h3>${escapeHtml(deal.title)}</h3><div class="hero-price"><span class="hero-now">${escapeHtml(deal.price)}</span>${deal.originalPrice ? `<span class="hero-was">${escapeHtml(deal.originalPrice)}</span>` : ''}${deal.discount ? `<span class="hero-off">${escapeHtml(`${Math.round(deal.discount)}% off`)}</span>` : ''}</div><div class="hero-cta"><span>${escapeHtml(deal.store)}</span><span>Grab deal &nearr;</span></div></div>
</a>`)
    .join('\n');

  // The hero carries the headline *and* the live flagship products, so a visitor sees
  // real discounted hardware above the fold instead of a slogan and a scroll.
  const spotlightHtml = spotlight
    ? `<div class="spotlight" id="spotlight">
<h2 class="spotlight-title" id="spotlight-title">Today's flagship deals</h2>
<p class="spotlight-note">Live Apple &amp; Samsung pricing, picked by deepest discount.</p>
<div class="spotlight-grid" id="spotlight-grid">${spotlight}</div>
</div>`
    : '<div class="spotlight" id="spotlight" hidden><div class="spotlight-grid" id="spotlight-grid"></div></div>';

  const chips = [
    { href: '/mobiles/', label: 'Mobiles', count: feed.filter(d => d.category === 'Mobiles').length },
    { href: '/laptops/', label: 'Laptops', count: feed.filter(d => d.category === 'Laptops').length },
    { href: '/electronics/', label: 'Electronics', count: feed.filter(d => d.category === 'Electronics').length },
    { href: '/amazon/', label: 'Amazon', count: amazon },
    { href: '/flipkart/', label: 'Flipkart', count: flipkart },
    { href: '/under-10000/', label: 'Under ₹10k', count: feed.filter(d => dealPrice(d) < 10000).length }
  ]
    .filter(chip => chip.count >= MIN_PAGE_DEALS)
    .map(chip => `<a class="chip" href="${chip.href}">${escapeHtml(chip.label)} <span class="chip-n">${chip.count}</span></a>`)
    .join('\n');

  const schema = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        url: `${SITE_URL}/`,
        name: SITE_NAME,
        description,
        inLanguage: 'en-IN',
        publisher: { '@id': `${SITE_URL}/#org` }
      },
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#org`,
        name: SITE_NAME,
        url: `${SITE_URL}/`,
        logo: { '@type': 'ImageObject', url: `${SITE_URL}/og-image.png`, width: 1200, height: 630 }
      },
      {
        '@type': 'CollectionPage',
        '@id': `${SITE_URL}/#page`,
        url: `${SITE_URL}/`,
        name: seoTitle,
        description,
        isPartOf: { '@id': `${SITE_URL}/#website` },
        about: { '@type': 'Thing', name: 'Discounted electronics deals on Amazon.in and Flipkart' },
        inLanguage: 'en-IN',
        mainEntity: itemListSchema('Live tech deals', description, shown, '/')
      },
      faqSchemaNode(homeFaq(), '/')
    ]
  };

  return `<!doctype html>
<html lang="en-IN">
<head>
${renderHead({ title: seoTitle, description, path: '/', ogTitle: title, ogDescription: description })}
<script type="application/ld+json">
${JSON.stringify(schema)}
</script>
<style>
${TOKENS}
${BASE_CSS}
${HOME_CSS}
</style>
</head>
<body>
${renderNav('/')}
<main class="wrap" id="main">
<section class="hero" aria-labelledby="hero-title">
<p class="eyebrow">Amazon.in &middot; Flipkart &middot; one page</p>
<h1 id="hero-title">Live tech deals,<br><span>without the hunt.</span></h1>
<p class="lede">Live discount listings from Amazon.in and Flipkart, rebuilt throughout the day. Expired and out-of-stock deals drop off automatically, so what you see is still buyable.</p>
${spotlightHtml}
</section>
${renderStats([
    ['Live deals', String(feed.length)],
    ['Amazon / Flipkart', `${amazon} / ${flipkart}`],
    ['Starting at', stats.min ? formatRupees(stats.min) : '—'],
    ['Avg. discount', `${stats.avgOff}%`]
  ])}
<section class="toolbar" aria-label="Deal controls">
<label class="sr-only" for="query">Search deals by product</label><input class="search" id="query" type="search" placeholder="Search phones, laptops, earbuds…" autocomplete="off">
<div class="toolbar-actions"><button class="refresh" id="refresh" type="button">Refresh now</button><button class="pause" id="pause" type="button" aria-pressed="false">Pause updates</button></div>
<div class="refresh-meta"><span class="status"><span class="dot" id="dot"></span><span id="status-text" role="status" aria-live="polite">Showing the last saved snapshot</span></span><span id="updated">Rebuilt ${escapeHtml(snapshotDate)}</span></div>
</section>
<section class="alerts" id="alerts" aria-labelledby="alerts-title" hidden>
<div class="alerts-text"><p class="eyebrow">Deal alerts</p><h2 id="alerts-title">Get 2 handpicked deals every morning.</h2><p>Allow notifications and we send the two best Amazon &amp; Flipkart deals once a day. No account, no spam, off any time.</p></div>
<div class="alerts-actions"><button class="alerts-btn" id="alerts-enable" type="button">Allow notifications</button><button class="alerts-btn ghost" id="alerts-disable" type="button" hidden>Turn off</button><span class="alerts-state" id="alerts-state" role="status" aria-live="polite"></span></div>
</section>
<p class="summary"><strong>${shown.length}</strong> of ${feed.length} live deals shown, ranked by discount${feed.length > shown.length ? ' &middot; browse the category pages below for the rest' : ''}.</p>
<div class="deal-grid" id="deal-grid">${cards}</div>
<nav class="chipbar" aria-label="Browse deals by category, store and price">${chips}</nav>
${renderDisclosure()}
<section class="prose" aria-labelledby="about-title">
<h2 id="about-title">About ${escapeHtml(SITE_NAME)}</h2>
<p>${escapeHtml(SITE_NAME)} is a free, independent tracker that shows live discounts from Amazon.in and Flipkart on one page. It reads public deal and search listings for phones, laptops, tablets, earbuds, smart watches, televisions and cameras, then ranks them by how much the price has dropped. There is no account, no app and no middleman: every card links straight to the marketplace listing.</p>
<h3>How the deal feed works</h3>
<ul>
<li><strong>Rebuilt throughout the day.</strong> A scheduled job re-reads both stores and republishes this page with whatever is live.</li>
<li><strong>Fresh only.</strong> Out-of-stock and expired listings are removed before publishing, and anything under ${escapeHtml(formatRupees(MIN_DEAL_PRICE))} is filtered out to keep the signal high.</li>
<li><strong>Both stores mixed in.</strong> ${amazon} Amazon.in deals and ${flipkart} Flipkart deals on one page, so you are not locked into one marketplace.</li>
<li><strong>Search and filter.</strong> Narrow by store, by category, or by typing a product name.</li>
</ul>
${faqHtmlBlock(homeFaq())}
<p class="note">Cheapest live listing at build time: ${cheapest ? escapeHtml(cheapest.price) : '—'}. Snapshot built ${escapeHtml(snapshotDate)}.</p>
</section>
<section class="cta-band" aria-labelledby="cta-alerts">
<div><h2 id="cta-alerts">Want the two best deals each morning?</h2><p>Allow notifications and we will send a short digest of the sharpest Amazon &amp; Flipkart discounts once a day. No account, no spam.</p></div>
<a href="/#alerts">Get deal alerts</a>
</section>
</main>
${renderFooter()}
${HOMEPAGE_RUNTIME}
</body>
</html>
`;
}

/** Convenience wrapper so main() can log what the homepage actually shipped. */
function buildHomePageWithStats(feed, snapshotDate) {
  const html = buildHomePage(feed, snapshotDate);
  return {
    html,
    count: (html.match(/class="deal"/g) || []).length,
    schemaCount: (html.match(/"@type"/g) || []).length
  };
}

/** The sitemap carries the homepage plus every page that actually shipped. */
function writeSitemap(extraPages, feed, snapshotDate) {
  const isoDate = snapshotDate.slice(0, 10);
  const total = feed.length;
  const bestOff = feed.length ? Math.round(Math.max(...feed.map(d => Number(d.discount) || 0))) : 0;

  const entries = [
    { loc: `${SITE_URL}/`, priority: '1.0', changefreq: 'hourly' },
    ...extraPages.map(page => ({ loc: `${SITE_URL}${page.href}`, priority: page.priority, changefreq: 'hourly' }))
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map(entry => `  <url>
    <loc>${entry.loc}</loc>
    <lastmod>${isoDate}</lastmod>
    <changefreq>${entry.changefreq}</changefreq>
    <priority>${entry.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;

  fs.writeFileSync(path.join(PUBLIC_DIR, 'sitemap.xml'), xml);
  console.log(`[pages] sitemap.xml — ${entries.length} URLs, lastmod ${isoDate}`);
  console.log(`[pages] feed: ${total} live deals, best discount ${bestOff}%`);
  return entries.length;
}

function main() {
  const snapshot = loadSnapshot();
  if (!snapshot) process.exit(0);

  const feed = feedFromSnapshot(snapshot);
  const amazon = publishable(snapshot?.amazon?.deals);
  const flipkart = publishable(snapshot?.flipkart?.deals);
  const snapshotDate = new Date(snapshot.updatedAt || Date.now()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  console.log(`[pages] snapshot ${snapshotDate} — pool ${feed.length} (cap ${MAX_DEALS}); amazon ${amazon.length}, flipkart ${flipkart.length}`);

  // Drop owned directories first: a slice that fell below the threshold this run
  // must not leave an indexable page behind from the previous one.
  cleanOwnedPages();

  // The homepage first: it is the highest-value page and the only one a crawler
  // was previously getting zero cards from.
  const home = buildHomePageWithStats(feed, snapshotDate);
  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), home.html);
  console.log(`[pages] index.html — ${home.count} cards, ${home.schemaCount} schema nodes`);

  const pages = [
    ...buildCategoryPages(feed, snapshotDate),
    ...buildStorePages(feed, snapshotDate),
    ...buildPricePages(feed, snapshotDate)
  ];

  const urls = writeSitemap(pages, feed, snapshotDate);
  console.log(`[pages] built ${pages.length} landing pages, ${urls} sitemap URLs`);
}

main();
