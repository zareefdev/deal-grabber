#!/usr/bin/env node
// Sends the daily "two deals" push.
//
//   node scripts/send-daily-push.js [--dry-run]
//
// Run by .github/workflows/daily-push.yml. Reads the freshest snapshot from the
// deployed site (falling back to the committed public/deals.json), picks the two
// stand-out deals, and fans them out to every stored subscription with a plain VAPID
// Web Push call — no third-party push service involved.
//
// Required environment (see README → Push notifications):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY   the deployment's key pair
//   PUSH_ADMIN_SECRET                     same value as the Pages secret
// Optional:
//   SITE_URL (default https://atof.in), VAPID_SUBJECT, PUSH_DEAL_COUNT (default 2)

const fs = require('node:fs');
const path = require('node:path');

const SITE = (process.env.SITE_URL || 'https://atof.in').replace(/\/+$/, '');
const ADMIN_SECRET = process.env.PUSH_ADMIN_SECRET || '';
const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
// The push service only accepts an https: or mailto: subject, so a local http://
// SITE_URL falls back to the deployed origin rather than an invalid one.
const SUBJECT = process.env.VAPID_SUBJECT || (SITE.startsWith('https://') ? `${SITE}/` : 'https://atof.in/');
const DEAL_COUNT = Math.max(1, Number(process.env.PUSH_DEAL_COUNT || 2));
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

const AMAZON_TAG = process.env.AMAZON_TAG || 'mdzareef-21';
// Accessories share a discount percentage with the phones they are for, which would
// make them permanent headline picks; keep them out of the digest.
const ACCESSORY = /screen ?protector|tempered|glass|case\b|back ?cover|cover\b|charger|cable|adapter|power ?bank|holder|strap|sleeve|pouch|\bskin\b|\bbumper\b|compatible|for (macbook|iphone|samsung|galaxy)/i;

function affiliateUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url, SITE);
    if (/(^|\.)amazon\./i.test(parsed.hostname)) parsed.searchParams.set('tag', AMAZON_TAG);
    return parsed.href;
  } catch {
    return url;
  }
}

function priceValue(deal) {
  const value = Number(String(deal.price || '').replace(/[^\d]/g, ''));
  return Number.isFinite(value) ? value : 0;
}

function isPushable(deal) {
  // A discount at or above 95% is far more often a bogus list price (a ₹41-lakh
  // "MRP" on a ₹11k tablet) than a real sale, and it would win the digest every
  // single day — so keep those out of the pick.
  return Boolean(deal && deal.id && deal.title && deal.url && deal.image) &&
    priceValue(deal) > 0 && Number(deal.discount) > 0 && Number(deal.discount) < 95 &&
    !ACCESSORY.test(deal.title);
}

async function loadSnapshot() {
  try {
    const response = await fetch(`${SITE}/api/deals`, { headers: { 'cache-control': 'no-cache' } });
    if (response.ok) return await response.json();
    console.warn(`[push] live snapshot returned HTTP ${response.status}; using the committed copy`);
  } catch (error) {
    console.warn(`[push] live snapshot unreachable (${error.message}); using the committed copy`);
  }
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'deals.json'), 'utf8'));
}

// Alternate stores so a single store's sale cannot fill the whole digest.
function pickDeals(snapshot, count) {
  const pools = {
    Amazon: ((snapshot.amazon || {}).deals || []).filter(isPushable).sort((a, b) => b.discount - a.discount),
    Flipkart: ((snapshot.flipkart || {}).deals || []).filter(isPushable).sort((a, b) => b.discount - a.discount)
  };
  const stores = Object.keys(pools).sort((a, b) => (pools[b][0] ? pools[b][0].discount : 0) - (pools[a][0] ? pools[a][0].discount : 0));
  const picks = [];
  const taken = new Set();
  for (let round = 0; picks.length < count && round < count; round += 1) {
    for (const store of stores) {
      const deal = pools[store][round];
      if (deal && !taken.has(deal.id)) {
        taken.add(deal.id);
        picks.push(deal);
        if (picks.length === count) break;
      }
    }
  }
  if (picks.length < count) {
    const rest = [...pools.Amazon, ...pools.Flipkart].filter(deal => !taken.has(deal.id)).sort((a, b) => b.discount - a.discount);
    for (const deal of rest) {
      picks.push(deal);
      if (picks.length === count) break;
    }
  }
  return picks;
}

function shorten(text, max) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function buildPayload(picks) {
  const body = picks
    .map((deal, index) => `${index + 1}. ${shorten(deal.title, 54)} — ${deal.price} (${Math.round(deal.discount)}% off)`)
    .join('\n');
  return JSON.stringify({
    title: picks.length === 1 ? 'Today’s top deal' : `Today’s top ${picks.length} deals`,
    body,
    image: picks[0].image,
    url: affiliateUrl(picks[0].url),
    tag: 'daily-deals',
    ts: Date.now()
  });
}

async function loadSubscriptions() {
  const response = await fetch(`${SITE}/api/push/subscribe`, {
    headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    cache: 'no-store'
  });
  // 503 is the deployment saying it has no push storage bound yet. That is a
  // configuration state rather than a failed digest, so report it and stop quietly
  // instead of failing the run every morning until storage is in place.
  if (response.status === 503) return null;
  if (!response.ok) throw new Error(`subscription list failed: HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.subscriptions) ? data.subscriptions : [];
}

async function dropSubscription(endpoint) {
  await fetch(`${SITE}/api/push/subscribe?endpoint=${encodeURIComponent(endpoint)}`, { method: 'DELETE' }).catch(() => {});
}

async function sendToAll(webpush, subscriptions, payload) {
  let sent = 0;
  let dropped = 0;
  let failed = 0;
  const queue = subscriptions.slice();

  // A small worker pool: enough parallelism to keep the job short, gentle enough
  // that a shared push service does not rate-limit the whole run.
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length) {
      const subscription = queue.shift();
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: subscription.keys },
          payload,
          { TTL: 12 * 60 * 60 }
        );
        sent += 1;
      } catch (error) {
        // 404/410 means the browser dropped the subscription — forget it.
        if (error.statusCode === 404 || error.statusCode === 410) {
          dropped += 1;
          await dropSubscription(subscription.endpoint);
        } else {
          failed += 1;
          console.warn(`[push] send failed (${error.statusCode || error.message})`);
        }
      }
    }
  });

  await Promise.all(workers);
  return { sent, dropped, failed };
}

async function main() {
  const picks = pickDeals(await loadSnapshot(), DEAL_COUNT);
  if (!picks.length) {
    console.log('::warning::No pushable deals in the current snapshot — nothing sent.');
    return;
  }

  const payload = buildPayload(picks);
  console.log('[push] digest:');
  for (const deal of picks) console.log(`    ${deal.store} ${deal.price} (${Math.round(deal.discount)}% off) ${shorten(deal.title, 70)}`);

  if (DRY_RUN) {
    console.log(`[push] dry run — payload:\n${payload}`);
    return;
  }
  if (!PUBLIC_KEY || !PRIVATE_KEY) {
    console.log('::warning::VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set — skipping the daily push.');
    return;
  }
  if (!ADMIN_SECRET) {
    console.log('::warning::PUSH_ADMIN_SECRET is not set — cannot read subscriptions; skipping the daily push.');
    return;
  }

  const webpush = require('web-push');
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);

  const subscriptions = await loadSubscriptions();
  if (!subscriptions) {
    console.log('::warning::The deployment has no push storage bound (SUBS), so there is nobody to send to — skipping the daily push.');
    return;
  }
  console.log(`[push] ${subscriptions.length} subscriber(s)`);
  if (!subscriptions.length) return;

  const { sent, dropped, failed } = await sendToAll(webpush, subscriptions, payload);
  console.log(`[push] sent=${sent} dropped=${dropped} failed=${failed}`);
}

main().catch(error => {
  console.error(`[push] ${error.message}`);
  process.exitCode = 1;
});
