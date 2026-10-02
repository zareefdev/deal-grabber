/**
 * Markup helpers shared by the generated landing pages and the static shell of
 * public/index.html. Keeping the card markup here means a crawler-visible card and
 * a JS-rendered card are byte-identical in structure, so the page does not shift when
 * the feed takes over.
 */

import { REFRESH_MINUTES, affiliateUrl, discountLabel, escapeHtml, formatRupees } from './publish.mjs';
// Re-exported so callers that already import the markup helpers keep one import site;
// the value itself is defined once, alongside the other shared rules.
export { REFRESH_MINUTES } from './publish.mjs';

export const SITE_NAME = 'Amazon to Flipkart Deals Grabber';
export const SITE_URL = 'https://atof.in';

/** Short freshness phrase for headlines, where "every N minutes" would bloat the title. */
export const FRESHNESS_PHRASE = 'throughout the day';

/** The design tokens the page is built from. Inlined once per page. */
export const TOKENS = `
:root{
  color-scheme:light;
  --ink:#0f1a15;
  --ink-2:#1d2a23;
  --muted:#5d6a63;
  --muted-2:#7c8880;
  --paper:#f4f5f0;
  --surface:#fff;
  --line:#e1e5dc;
  --line-2:#eef0ea;
  --lime:#c8f26c;
  --lime-deep:#5b8a2a;
  --lime-ink:#2c451a;
  --amber:#b06a12;
  --font-ui:'Inter','Ubuntu',system-ui,-apple-system,'Segoe UI',sans-serif;
  --font-display:'Ubuntu','Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
  --radius:16px;
  --shadow:0 1px 2px rgba(15,26,21,.04),0 8px 24px -18px rgba(15,26,21,.35);
}
`.trim();

export const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--font-ui);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit}
button,input{font:inherit;color:inherit}
img{max-width:100%}
:focus-visible{outline:3px solid var(--lime-deep);outline-offset:3px;border-radius:4px}
.wrap{width:min(1180px,100%);margin-inline:auto;padding-inline:24px;padding-inline:calc(24px + env(safe-area-inset-left)) calc(24px + env(safe-area-inset-right))}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip-link{position:absolute;left:12px;top:-60px;z-index:20;padding:10px 16px;border-radius:0 0 10px 10px;background:var(--ink);color:#fff;font-size:13px;font-weight:700;text-decoration:none;transition:top .18s ease}
.skip-link:focus{top:0}

/* ── Header ─────────────────────────────────────────────── */
.topline{padding:9px 16px;padding:calc(9px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 9px calc(16px + env(safe-area-inset-left));background:var(--ink);color:#dbe4dd;text-align:center;font-size:12px;letter-spacing:.01em}
.topline strong{color:var(--lime);font-weight:700}
.nav{display:flex;align-items:center;gap:14px;min-height:68px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:9px;min-height:44px;font-family:var(--font-display);font-size:18px;font-weight:700;letter-spacing:-.03em;text-decoration:none;white-space:nowrap}
.mark{display:grid;place-items:center;flex:0 0 auto;width:30px;height:30px;border-radius:9px;background:var(--lime);color:var(--lime-ink);font-size:16px}
.nav-links{display:flex;align-items:center;gap:2px;margin-inline-start:auto;overflow-x:auto;scrollbar-width:none}
.nav-links::-webkit-scrollbar{display:none}
.nav-links a{display:inline-flex;align-items:center;min-height:40px;padding:0 11px;border-radius:9px;color:var(--muted);font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap;transition:color .15s ease,background .15s ease}
.nav-links a:hover{background:var(--line-2);color:var(--ink)}
.nav-links a[aria-current=page]{color:var(--ink);background:var(--line-2)}

/* ── Hero ───────────────────────────────────────────────── */
.hero{padding:44px 0 26px}
.eyebrow{color:var(--lime-deep);font-size:11px;font-weight:700;letter-spacing:.11em;text-transform:uppercase}
.hero h1{max-width:19ch;margin:12px 0 0;font-family:var(--font-display);font-size:clamp(34px,6vw,60px);font-weight:700;letter-spacing:-.05em;line-height:1.02}
.hero .lede{max-width:62ch;margin:16px 0 0;color:var(--muted);font-size:16px;line-height:1.6}
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 16px;color:var(--muted-2);font-size:12px}
.crumbs a{text-decoration:none}
.crumbs a:hover{text-decoration:underline}
.crumbs li{list-style:none}
.crumbs ol{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0}
.crumbs li+li::before{content:'/';margin-inline-end:6px;color:var(--line)}

/* ── Stats strip ────────────────────────────────────────── */
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;margin:0 0 26px;border:1px solid var(--line);border-radius:var(--radius);background:var(--line);overflow:hidden}
.stats div{padding:14px 16px;background:var(--surface)}
.stats dt{color:var(--muted-2);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.stats dd{margin:3px 0 0;font-family:var(--font-display);font-size:20px;font-weight:700;letter-spacing:-.03em}

/* ── Filter chips ───────────────────────────────────────── */
.chipbar{display:flex;gap:7px;overflow-x:auto;padding:2px;margin:0 0 14px;scrollbar-width:thin;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain}
.chip{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;min-height:40px;padding:0 13px;border:1px solid var(--line);border-radius:99px;background:var(--surface);color:var(--muted);font-size:12.5px;font-weight:600;text-decoration:none;white-space:nowrap;transition:border-color .15s ease,color .15s ease,background .15s ease}
.chip:hover{border-color:var(--lime-deep);color:var(--ink)}
.chip[aria-current=page],.chip.is-on{border-color:var(--ink);background:var(--ink);color:#fff}
.chip[aria-current=page] .chip-n,.chip.is-on .chip-n{color:#cbd6cc}

/* ── Deal grid + card ───────────────────────────────────── */
.deal-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px}
.deal{display:flex;flex-direction:column;min-width:0;overflow:hidden;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
.deal:hover{transform:translateY(-3px);border-color:#cfd6c8;box-shadow:0 1px 2px rgba(15,26,21,.05),0 18px 38px -22px rgba(15,26,21,.45)}
.deal-media{position:relative;aspect-ratio:4/3;background:#f6f7f3;display:grid;place-items:center;overflow:hidden}
.deal-media img{width:100%;height:100%;object-fit:contain;mix-blend-mode:multiply}
.deal-media figcaption{position:absolute;inset:0;display:grid;place-items:center;padding:12px;color:#a9b0a6;font-size:12px;text-align:center}
.deal-badges{position:absolute;inset:9px 9px auto;display:flex;flex-wrap:wrap;gap:5px;align-items:flex-start}
.pill{display:inline-flex;align-items:center;min-height:22px;padding:0 7px;border-radius:6px;font-size:10.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;background:var(--surface)}
.pill-off{background:#e9f5d6;color:#3f6b1c}
.pill-new{background:#e4edff;color:#1c47c4}
.pill-store{background:rgba(255,255,255,.92);color:var(--muted);box-shadow:inset 0 0 0 1px var(--line)}
.deal-body{display:flex;flex:1;flex-direction:column;padding:13px}
.deal h3{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:3;min-height:3.9em;margin:0 0 10px;font-size:13.5px;font-weight:600;line-height:1.32;letter-spacing:-.01em}
.price-row{display:flex;align-items:baseline;gap:8px;margin-bottom:12px}
.price{font-family:var(--font-display);font-size:19px;font-weight:700;letter-spacing:-.03em}
.was{color:var(--muted-2);font-size:11.5px;text-decoration:line-through}
.deal-cta{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;margin-top:auto;padding-top:10px;border-top:1px solid var(--line-2);font-size:12.5px;font-weight:700;text-decoration:none}
.deal-cta:hover{color:var(--lime-deep)}
.deal-cta span:last-child{font-size:15px}

.state{grid-column:1/-1;padding:38px 22px;border:1px dashed #ccd2c6;border-radius:var(--radius);background:var(--surface);text-align:center}
.state h3{margin:0 0 8px;font-size:18px;letter-spacing:-.02em}
.state p{max-width:56ch;margin:0 auto 16px;color:var(--muted);font-size:13.5px}
.state a{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:10px;background:var(--ink);color:#fff;font-size:13px;font-weight:700;text-decoration:none}
.summary{margin:0 0 16px;color:var(--muted);font-size:12.5px}
.summary strong{color:var(--ink);font-weight:700}

/* ── Prose block ────────────────────────────────────────── */
.prose{margin:44px 0 0;padding:26px 28px;border:1px solid var(--line);border-radius:18px;background:var(--surface)}
.prose h2{margin:0 0 12px;font-family:var(--font-display);font-size:clamp(20px,2.6vw,26px);font-weight:700;letter-spacing:-.04em;line-height:1.1}
.prose h3{margin:24px 0 8px;font-size:15px;font-weight:700;letter-spacing:-.02em}
.prose p,.prose li,.prose dd{margin:0 0 10px;color:var(--muted);font-size:13.5px;line-height:1.68}
.prose ul{margin:8px 0 14px;padding-inline-start:20px}
.prose li{margin:5px 0}
.prose dt{margin-top:14px;font-size:13.5px;font-weight:700}
.prose dd{margin:4px 0 0}
.prose table{width:100%;margin:12px 0 4px;border-collapse:collapse;font-size:13px}
.prose th,.prose td{padding:9px 12px;border-bottom:1px solid var(--line);text-align:left}
.prose th{color:var(--ink);font-weight:700;background:var(--line-2)}
.prose td{color:var(--muted)}
.prose a{color:var(--ink);font-weight:600}

.cta-band{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px;margin:26px 0 0;padding:20px 24px;border-radius:18px;background:linear-gradient(120deg,var(--ink-2),#101a15);color:#e7eee8}
.cta-band h2{margin:0;font-family:var(--font-display);font-size:clamp(18px,2.4vw,23px);font-weight:700;letter-spacing:-.03em}
.cta-band p{max-width:52ch;margin:6px 0 0;color:#a9b7ac;font-size:13px;line-height:1.55}
.cta-band a{display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:11px;background:var(--lime);color:var(--lime-ink);font-size:13px;font-weight:700;text-decoration:none;white-space:nowrap}

/* ── Footer ─────────────────────────────────────────────── */
.footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px 28px;margin-top:48px;padding:20px 0 28px;padding-bottom:calc(28px + env(safe-area-inset-bottom));border-top:1px solid var(--line);color:var(--muted-2);font-size:11.5px;line-height:1.6}
.footer a{color:inherit}
.footer h2{margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.footer-links{display:flex;flex-wrap:wrap;gap:4px 14px}
/* Footer and breadcrumb links were bare text runs (18px / 15px tall), so on a phone
   they were easy to miss and easy to mistap. Give them a 40px hit area on small
   screens and tighten the gap so the padding does not inflate the footer. */
@media (max-width:600px){
  .footer-links{gap:0 6px}
  .footer-links a{display:inline-flex;align-items:center;min-height:40px;padding:0 4px}
  .crumbs{margin-bottom:12px}
  .crumbs ol{gap:0 2px}
  .crumbs li{display:inline-flex;align-items:center;min-height:40px}
  .crumbs a{display:inline-flex;align-items:center;min-height:40px;padding:0 4px}
  .note{margin-top:14px}
}
.note{margin:20px 0 0;color:var(--muted-2);font-size:11.5px;line-height:1.6}

@media (max-width:1000px){.deal-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:820px){
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .deal-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .nav{flex-wrap:wrap;min-height:0;padding:10px 0}
  /* Every category must be reachable: the row used to scroll off-screen with a
     half-clipped "Ama…" and no affordance, so the links wrapped instead. */
  .nav-links{margin-inline-start:0;width:100%;flex-wrap:wrap;overflow:visible;gap:4px}
  .hero{padding:26px 0 18px}
}
@media (max-width:560px){
  .wrap{padding-inline:16px;padding-inline:calc(16px + env(safe-area-inset-left)) calc(16px + env(safe-area-inset-right))}
  .brand{font-size:16px}
  /* 44px is the smallest reliably hittable row on a phone; at 36px the links were
     hard to tap and sat inside a 40px-high .nav that also shrank on some devices. */
  .nav-links a{min-height:44px;padding:0 11px;font-size:13px}
  .hero{padding:20px 0 14px}
  .hero h1{margin-top:9px;font-size:clamp(28px,8.5vw,36px);letter-spacing:-.045em}
  .hero .lede{margin-top:12px;font-size:14.5px;line-height:1.55}
  .stats{margin-bottom:18px}
  .stats div{padding:11px 13px}
  .stats dd{font-size:17px}
  .deal-grid{gap:9px}
  .deal-media{aspect-ratio:1.1}
  .deal-body{padding:10px}
  /* No min-height: it forced a 4.3em block on every card, so short titles left a
     dead gap above the price. Grid already equalises row heights. */
  .deal h3{font-size:12.5px;line-height:1.36;min-height:0;margin-bottom:7px}
  .price{font-size:16px}
  .deal-cta{min-height:40px;font-size:12px}
  .pill{min-height:20px;padding:0 6px;font-size:9.5px}
  .prose{padding:18px;margin-top:32px}
  .prose table{font-size:12.5px}
  .prose th,.prose td{padding:8px 10px}
  .cta-band{padding:16px}
  .cta-band a{width:100%;justify-content:center}
  .footer{flex-direction:column}
}
@media (prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}
`.trim();

/**
 * One deal card. The generator writes these straight into the HTML for crawlers;
 * the runtime re-renders the same shape into the live grid, so the DOM does not
 * change shape when data takes over.
 */
export function renderDealCard(deal) {
  const url = affiliateUrl(deal.url);
  const title = escapeHtml(deal.title);
  const off = discountLabel(deal);
  const was = deal.originalPrice && deal.originalPrice !== deal.price
    ? `<span class="was">${escapeHtml(deal.originalPrice)}</span>`
    : '';
  const image = deal.image
    ? `<img src="${escapeHtml(deal.image)}" alt="${title}" width="400" height="300" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : `<figcaption>Image unavailable</figcaption>`;
  const badges = [
    `<span class="pill pill-store">${escapeHtml(deal.store)}</span>`,
    off ? `<span class="pill pill-off">${escapeHtml(off)}</span>` : '',
    deal.isNew ? `<span class="pill pill-new">New</span>` : ''
  ].filter(Boolean).join('');

  return `<article class="deal">
<figure class="deal-media">${image}<div class="deal-badges">${badges}</div></figure>
<div class="deal-body">
<h3>${title}</h3>
<div class="price-row">${was}<span class="price">${escapeHtml(deal.price)}</span></div>
<a class="deal-cta" href="${escapeHtml(url)}" target="_blank" rel="sponsored noopener noreferrer"><span>View on ${escapeHtml(deal.store)}</span><span aria-hidden="true">&nearr;</span></a>
</div>
</article>`;
}

export function renderHead({ title, description, path, ogTitle, ogDescription }) {
  const url = `${SITE_URL}${path}`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
<meta name="theme-color" content="#f4f5f0" media="(prefers-color-scheme: light)">
<meta name="color-scheme" content="light">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="author" content="${escapeHtml(SITE_NAME)}">
<meta name="geo.region" content="IN">
<meta name="geo.placename" content="India">
<meta name="application-name" content="${escapeHtml(SITE_NAME)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Deals Grabber">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&amp;family=Ubuntu:wght@400;500;700&amp;display=swap">
<link rel="dns-prefetch" href="https://www.amazon.in">
<link rel="dns-prefetch" href="https://www.flipkart.com">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
<meta property="og:title" content="${escapeHtml(ogTitle || title)}">
<meta property="og:description" content="${escapeHtml(ogDescription || description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE_URL}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(ogTitle || title)}">
<meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(ogTitle || title)}">
<meta name="twitter:description" content="${escapeHtml(ogDescription || description)}">
<meta name="twitter:image" content="${SITE_URL}/og-image.png">`;
}

/** Nav shown on every page; `current` gets aria-current so the active tab is obvious. */
export function renderNav(current) {
  const links = [
    { href: '/', label: 'All deals' },
    { href: '/mobiles/', label: 'Mobiles' },
    { href: '/laptops/', label: 'Laptops' },
    { href: '/electronics/', label: 'Electronics' },
    { href: '/amazon/', label: 'Amazon' },
    { href: '/flipkart/', label: 'Flipkart' },
    { href: '/under-10000/', label: 'Under ₹10k' }
  ];
  const items = links.map(link => {
    const on = link.href === current;
    return `<a href="${link.href}"${on ? ' aria-current="page"' : ''}>${escapeHtml(link.label)}</a>`;
  }).join('');

  return `<a class="skip-link" href="#main">Skip to deals</a>
<div class="topline"><strong>Live deal feed</strong> &middot; Amazon &amp; Flipkart prices, refreshed every ${REFRESH_MINUTES} minutes</div>
<header class="wrap nav">
<a class="brand" href="/"><span class="mark" aria-hidden="true">&nearr;</span> ${escapeHtml(SITE_NAME)}</a>
<nav class="nav-links" aria-label="Deal categories">${items}</nav>
</header>`;
}

export function renderFooter() {
  return `<footer class="wrap footer">
<div><h2>${escapeHtml(SITE_NAME)}</h2><p>An independent deal tracker for Amazon.in and Flipkart. Not affiliated with either store.</p></div>
<div><h2>Browse</h2><div class="footer-links">
<a href="/">All deals</a><a href="/mobiles/">Mobiles</a><a href="/laptops/">Laptops</a>
<a href="/electronics/">Electronics</a><a href="/amazon/">Amazon</a><a href="/flipkart/">Flipkart</a>
<a href="/under-5000/">Under ₹5,000</a><a href="/under-10000/">Under ₹10,000</a>
<a href="/under-25000/">Under ₹25,000</a><a href="/over-50000/">Above ₹50,000</a>
</div></div>
</footer>`;
}

/** Legal/affiliate line that must appear on every page that lists deals. */
export function renderDisclosure() {
  return `<p class="note">Listings are read from public Amazon.in and Flipkart deal pages and prices and stock can change before you reach the store. Some outbound links are affiliate links: as an Amazon Associate this site earns from qualifying purchases, at no extra cost to you.</p>`;
}

export function renderStats(entries) {
  const cells = entries.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  return `<dl class="stats">${cells}</dl>`;
}
