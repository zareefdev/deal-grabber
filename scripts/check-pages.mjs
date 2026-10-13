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
import { fileURLToPath } from 'node:url';
import { requireChrome } from './lib/chrome.mjs';

const [, , base = 'http://127.0.0.1:8899', ...slugs] = process.argv;

const CHROME = requireChrome();

const PUBLIC_DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'public');

/**
 * The generator drops a landing page when its slice falls under MIN_PAGE_DEALS, so a
 * hardcoded page list turned a legitimately thin band — "only 6 deals under ₹5,000" —
 * into a failed check, which aborted the job *before* the deploy step and left the site
 * frozen on its previous build. Check exactly the pages that were built, plus the
 * homepage, so a thin snapshot can never block a publish.
 */
function builtSlugs() {
  let entries = [];
  try { entries = fs.readdirSync(PUBLIC_DIR, { withFileTypes: true }); } catch { return ['']; }
  return ['', ...entries
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(PUBLIC_DIR, entry.name, 'index.html')))
    .map(entry => `${entry.name}/`)];
}

const PAGES = (slugs.length ? slugs : builtSlugs())
  .map(slug => ({ slug: slug || 'index', url: `${base.replace(/\/$/, '')}/${slug}` }));

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Chrome holds the profile directory open for a moment after SIGTERM, so the rm that
 * used to run immediately after kill() raced it and threw ENOTEMPTY — turning a
 * passing check into a failed one. Wait for the process to actually exit, then retry
 * the removal so a slow shutdown cannot fail the run.
 */
async function teardown(client) {
  if (!client) return;
  client.ws?.close();
  if (client.chrome.exitCode === null && client.chrome.signalCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        client.chrome.kill('SIGKILL');
        resolve();
      }, 3000);
      timer.unref?.();
      client.chrome.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      client.chrome.kill();
    });
  }
  // Best-effort only: Chrome's helper processes can keep the profile open a moment
  // past the main process exiting, and a leftover temp directory is harmless. Failing
  // the check because cleanup raced Chrome is exactly the bug this guards against.
  try {
    fs.rmSync(client.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}

/**
 * Chromium sometimes fails to open its debugging port on a cold CI runner, and a thrown
 * launch failed the whole check — which, because the check gates the deploy, turned a
 * flaky browser startup into a missed publish. Give a slow cold start a longer budget
 * (20s) and let launch() respawn once before giving up.
 */
async function startChrome() {
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
  for (let i = 0; i < 100 && !wsUrl; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) wsUrl = (await res.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) {
    chrome.kill();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    return null;
  }
  return { chrome, profile, wsUrl };
}

async function launch() {
  if (!fs.existsSync(CHROME)) throw new Error(`no chromium at ${CHROME}`);
  const started = await startChrome() || await startChrome();
  if (!started) throw new Error('chromium never exposed a debugging port');
  const { chrome, profile, wsUrl } = started;

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
    crumbs: !!document.querySelector('.crumbs'),
    // A crumb that names the current page twice is a duplicate. Count how many crumb
    // labels match the h1 — it must be exactly one, and it must be the current page.
    crumbDupes: (() => {
      const ol = document.querySelector('.crumbs ol');
      if (!ol) return 0;
      const h1 = (document.querySelector('h1') || {}).textContent || '';
      const norm = s => s.trim().replace(/\\s+/g, ' ').toLowerCase();
      const labels = [...ol.querySelectorAll('li')].map(li => li.textContent);
      return labels.filter(l => norm(l) && norm(l) === norm(h1)).length - 1;
    })(),
    faqSchemaQuestions: (() => {
      const node = ld.flatMap(v => (v && v['@graph']) || [v]).find(n => n && n['@type'] === 'FAQPage');
      return node ? node.mainEntity.length : 0;
    })(),
    faqEmptyAnswers: (() => {
      const node = ld.flatMap(v => (v && v['@graph']) || [v]).find(n => n && n['@type'] === 'FAQPage');
      if (!node) return 0;
      return node.mainEntity.filter(q => {
        const t = q.acceptedAnswer && q.acceptedAnswer.text;
        return !t || String(t).trim().length < 15;
      }).length;
    })(),
    faqEmptyVisible: (() => {
      // Scoped to the prose FAQ list: the stats strip is also a <dl> and its values
      // are legitimately short ("89", "₹7,999").
      const lists = [...document.querySelectorAll('.prose dl')];
      return lists.reduce((n, dl) => n + [...dl.querySelectorAll('dd')].filter(dd => !dd.textContent.trim() || dd.textContent.trim().length < 15).length, 0);
    })(),
    faqVisibleQuestions: document.querySelectorAll('.prose dl > dt').length
  };
})())`;

let client;
let failures = 0;

try {
  client = await launch();
  const { send, listeners } = client;

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
      // A blank acceptedAnswer.text is invalid structured data and a blank <dd> is
      // visible junk on the page, so both are hard failures rather than warnings.
      [data.faqEmptyAnswers === 0, `${data.faqEmptyAnswers} FAQ questions have an empty answer in the schema`],
      [data.faqEmptyVisible === 0, `${data.faqEmptyVisible} visible FAQ answers are blank`],
      [data.crumbDupes <= 0, `breadcrumb names the current page ${data.crumbDupes + 1}×`],
      // Google only credits FAQPage markup when the answers are actually on the page,
      // so schema without visible questions is a structured-data violation, not a nit.
      [data.faqSchemaQuestions === 0 || data.faqVisibleQuestions >= data.faqSchemaQuestions,
        `FAQPage claims ${data.faqSchemaQuestions} questions but only ${data.faqVisibleQuestions} are rendered`],
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

  await teardown(client);
  console.log(failures ? `\n${failures} page(s) failed` : '\nAll pages passed');
  process.exitCode = failures ? 1 : 0;
} catch (error) {
  await teardown(client);
  console.error('FAILED:', error.message);
  process.exitCode = 1;
}
