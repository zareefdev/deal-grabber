#!/usr/bin/env node
/**
 * Mobile layout audit. check-pages.mjs only ever renders at 1280px, so nothing in CI
 * catches the failure mode that matters most on this site: a phone-width page that
 * scrolls sideways, clips its nav, or ships tap targets too small to hit.
 *
 * Loads each page in headless Chromium at phone width and reports horizontal
 * overflow, the elements responsible for it, undersized tap targets, and any
 * console exception. Exit code is non-zero when a hard failure is found.
 *
 * Usage: node scripts/audit-mobile.mjs <base-url> [slug ...]
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

const SLUGS = slugs.length ? slugs : ['', 'mobiles/', 'laptops/', 'electronics/', 'amazon/', 'flipkart/', 'under-5000/', 'over-50000/'];
const WIDTHS = [390, 360];
const MIN_TAP = 40;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch() {
  if (!fs.existsSync(CHROME)) throw new Error(`no chromium at ${CHROME}`);
  const port = 9600 + Math.floor(Math.random() * 300);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
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

// Reports only the worst offenders: an overflowing page has many descendants of the
// culprit, so naming every one buries the single element that actually needs fixing.
const PROBE = width => `JSON.stringify((() => {
  const vw=${width};
  const doc=document.documentElement;
  const overflow=Math.max(doc.scrollWidth,document.body.scrollWidth)-vw;
  const label=el=>el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(el.className&&typeof el.className==='string'?'.'+el.className.trim().split(/\\s+/).slice(0,2).join('.'):'');
  const describe=el=>{
    const r=el.getBoundingClientRect();
    return label(el)+' ['+Math.round(r.left)+'→'+Math.round(r.right)+' w'+Math.round(r.width)+']';
  };
  const culprits=[];
  if(overflow>0){
    for(const el of document.querySelectorAll('body *')){
      const r=el.getBoundingClientRect();
      if(r.width===0||r.height===0)continue;
      if(r.right>vw+1||r.left<-1){
        const parent=el.parentElement;
        const pr=parent?parent.getBoundingClientRect():null;
        const parentOverflows=pr&&(pr.right>vw+1||pr.left<-1);
        if(!parentOverflows)culprits.push(describe(el));
      }
      if(culprits.length>=6)break;
    }
  }
  const tapTooSmall=[...document.querySelectorAll('a[href],button,input,select')].filter(el=>{
    const r=el.getBoundingClientRect();
    if(r.width===0||r.height===0)return false;
    // Card media, prose and images are not tap targets in their own right, and the
    // skip-link sits off-screen until focused (top:-60px), so neither is measured.
    if(el.closest('.deal-media,.hero-media,img,footer,.prose,svg,path,.skip-link'))return false;
    return r.height<${MIN_TAP};
  }).slice(0,8).map(el=>{
    const r=el.getBoundingClientRect();
    return label(el)+' h'+Math.round(r.height);
  });
  const grid=document.querySelector('#deal-grid')||document.querySelector('.deal-grid');
  const navHost=document.querySelector('.nav-links');
  const nav=navHost?[...navHost.querySelectorAll('a')].map(a=>{
    const r=a.getBoundingClientRect();
    return {t:a.textContent.trim(),w:Math.round(r.width),h:Math.round(r.height),visible:r.width>0&&r.top<window.innerHeight};
  }).filter(x=>x.w>0):[];
  return {
    vw,
    scrollW:Math.max(doc.scrollWidth,document.body.scrollWidth),
    overflow,
    culprits,
    tapTooSmall,
    cards:grid?grid.querySelectorAll('.deal').length:0,
    hero:document.querySelectorAll('.hero-card').length,
    heroTags:[...document.querySelectorAll('.hero-tag')].map(e=>e.textContent.trim()),
    navCount:nav.length,
    navTiny:nav.filter(n=>n.h<${MIN_TAP}).length,
    navFirstRow:nav.filter(n=>n.h>0).length
  };
})())`;

let client;
let failures = 0;

try {
  client = await launch();
  const { chrome, profile, ws, send, listeners } = client;

  for (const slug of SLUGS) {
    const url = `${base.replace(/\/$/, '')}/${slug}`;
    for (const width of WIDTHS) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

      const problems = [];
      listeners.push(msg => {
        if (msg.sessionId !== sessionId) return;
        if (msg.method === 'Runtime.exceptionThrown') {
          problems.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).split('\n')[0]);
        }
      });

      await send('Page.enable', {}, sessionId);
      await send('Runtime.enable', {}, sessionId);
      await send('Emulation.setDeviceMetricsOverride', {
        width, height: 844, deviceScaleFactor: 1, mobile: true
      }, sessionId);
      await send('Page.navigate', { url }, sessionId);
      await sleep(2400);

      const res = await send('Runtime.evaluate', { expression: PROBE(width), returnByValue: true }, sessionId);
      const d = JSON.parse(res.result.value);

      const bad = [];
      if (d.overflow > 1) bad.push(`overflows by ${d.overflow}px: ${d.culprits.slice(0, 3).join(' , ') || 'unknown'}`);
      if (d.tapTooSmall.length) bad.push(`${d.tapTooSmall.length} tap targets < ${MIN_TAP}px: ${d.tapTooSmall.slice(0, 3).join(' , ')}`);
      if (d.cards === 0) bad.push('no cards rendered');
      if (problems.length) bad.push(problems.slice(0, 2).join(' | '));

      if (bad.length) failures += 1;
      console.log(`${bad.length ? 'FAIL' : 'ok  '}  /${slug || 'index'} @${width}`.padEnd(26) +
        `scroll=${d.scrollW} cards=${String(d.cards).padStart(3)} hero=${d.hero}[${d.heroTags.join(',')}] nav=${d.navCount}/${d.navTiny}tiny`);

      if (bad.length) bad.forEach(m => console.log(`        -> ${m}`));
      await send('Target.closeTarget', { targetId });
    }
  }

  chrome.kill();
  ws.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `\n${failures} viewport(s) failed` : '\nAll mobile viewports passed');
  process.exitCode = failures ? 1 : 0;
} catch (error) {
  if (client) {
    client.chrome.kill();
    fs.rmSync(client.profile, { recursive: true, force: true });
  }
  console.error('FAILED:', error.message);
  process.exitCode = 1;
}
