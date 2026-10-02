#!/usr/bin/env node
/**
 * Post-build smoke test for the generated pages.
 *
 * The generator writes the cards, but the page only really works if the runtime
 * takes over cleanly: it must not throw, it must keep the baked-in snapshot when
 * the feed endpoint is unreachable, and it must not leave a half-rendered grid.
 *
 * Runs each page through headless Chromium over CDP (no npm install needed) and
 * asserts the DOM the crawler-visible markup is supposed to produce.
 *
 * Usage: node scripts/check-pages.mjs <base-url> [slug ...]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , base = 'http://127.0.0.1:8899', ...slugs] = process.argv;

const CHROME = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
);

const PAGES = (slugs.length ? slugs : ['', 'mobiles/', 'laptops/', 'electronics/', 'amazon/', 'flipkart/', 'under-5000/', 'under-10000/', 'under-25000/', 'over-50000/'])
  .map(slug => ({ slug: slug || 'index', url: `${base.replace(/\/$/, '')}/${slug}` }));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch() {
  if (!fs.existsSync(CHROME)) throw new Error(`no chromium at ${CHROME}`);
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpages-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank'
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) wsUrl = (await res.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) {
    chrome.kill();
    throw new Error('chromium never exposed a debugging port');
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      listeners.forEach(fn => fn(msg));
    }
  });

  const send = (method, params = {}, sessionId) => {
    id += 1;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(payload));
    });
  };

  return { chrome, profile, ws, send, listeners };
}

const PROBE = `JSON.stringify((() => {
  const grid = document.querySelector('#deal-grid') || document.querySelector('.deal-grid');
  const cards = grid ? [...grid.querySelectorAll('.deal')] : [];
  const broken = cards.filter(c => { const i = c.querySelector('img'); return i && i.complete && i.naturalWidth === 0; }).length;
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(s => { try { return JSON.parse(s.textContent); } catch { return 'INVALID'; } });
  return {
    title: document.title,
    canonical: (document.querySelector('link[rel=canonical]') || {}).href || null,
    h1: [...document.querySelectorAll('h1')].map(h => h.textContent.trim()),
    cards: cards.length,
    brokenImages: broken,
    emptyHrefs: cards.filter(c => { const a = c.querySelector('a[href]'); return !a || !/^https?:/.test(a.getAttribute('href') || ''); }).length,
    affiliateTagged: cards.filter(c => { const a = c.querySelector('a[href]'); return a && /amazon\\.in/.test(a.href) && /[?&]tag=/.test(a.href); }).length,
    amazonCards: cards.filter(c => (c.querySelector('.pill-store') || {}).textContent === 'Amazon').length,
    ldCount: ld.length,
    ldValid: ld.every(v => v !== 'INVALID'),
    ldTypes: [...new Set(ld.flatMap(v => (v && v['@graph']) || [v]).filter(Boolean).map(n => n['@type']))].sort(),
    navLinks: document.querySelectorAll('.nav-links a').length,
    footerLinks: document.querySelectorAll('.footer a').length,
    dealsMatchLd: !!document.querySelector('#deals-schema'),
    hasSkipLink: !!document.querySelector('.skip-link'),
    crumbs: !!document.querySelector('.crumbs')
  };
})())`;

let client;
let failures = 0;

try {
  client = await launch();
  const { chrome, profile, ws, send, listeners } = client;

  for (const page of PAGES) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

    const problems = [];
    listeners.push(msg => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        problems.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).split('\n')[0]);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        problems.push('console.error: ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 160));
      }
    });

    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.navigate', { url: page.url }, sessionId);
    await sleep(2600);

    const res = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId);
    const data = JSON.parse(res.result.value);
    // The /api/deals 503 on a static file server is expected locally.
    const real = problems.filter(p => !/api\/deals|Failed to load resource|net::ERR/i.test(p));

    const checks = [
      [data.cards > 0, `no cards rendered (${data.cards})`],
      [data.h1.length === 1, `expected exactly one h1, got ${data.h1.length}`],
      [!!data.canonical, 'no canonical link'],
      [data.ldValid, 'invalid JSON-LD'],
      [data.ldTypes.includes('ItemList') || data.slug !== 'index', 'no ItemList schema'],
      [data.emptyHrefs === 0, `${data.emptyHrefs} cards without a valid http(s) link`],
      [data.brokenImages === 0, `${data.brokenImages} broken images`],
      [data.affiliateTagged === data.amazonCards, `only ${data.affiliateTagged}/${data.amazonCards} Amazon links carry the affiliate tag`],
      [data.navLinks >= 5, `only ${data.navLinks} nav links`],
      [real.length === 0, real.slice(0, 3).join(' | ')]
    ];
    const failed = checks.filter(([ok]) => !ok);

    if (failed.length) failures += 1;
    console.log(`${failed.length ? 'FAIL' : 'ok  '}  /${page.slug}`.padEnd(22) +
      `cards=${String(data.cards).padStart(3)} amz=${String(data.amazonCards).padStart(3)} ` +
      `tagged=${String(data.affiliateTagged).padStart(3)} ld=[${data.ldTypes.join(',')}] nav=${data.navLinks} foot=${data.footerLinks}`);
    if (failed.length) failed.forEach(([, msg]) => console.log(`        -> ${msg}`));

    await send('Target.closeTarget', { targetId });
  }

  chrome.kill();
  ws.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `\n${failures} page(s) failed` : '\nAll pages passed');
  process.exitCode = failures ? 1 : 0;
} catch (error) {
  if (client) {
    client.chrome.kill();
    fs.rmSync(client.profile, { recursive: true, force: true });
  }
  console.error('FAILED:', error.message);
  process.exitCode = 1;
}
