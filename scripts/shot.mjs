#!/usr/bin/env node
/**
 * Screenshot a local page over CDP using the playwright-managed Chromium that is
 * already on this machine. Used to eyeball the redesign without installing anything.
 *
 * Usage: node scripts/shot.mjs <url> <outfile> [width] [height] [fullPage]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , url, out, width = '1280', height = '1400', fullPage = 'false'] = process.argv;
if (!url || !out) {
  console.error('usage: node scripts/shot.mjs <url> <outfile> [w] [h] [fullPage]');
  process.exit(1);
}

const BIN = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
);
const PORT = 9333 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));

const chrome = spawn(BIN, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--font-render-hinting=none',
  `about:blank`
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('chromium did not expose a debugging port');
}

function cdp(ws) {
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
  return {
    send(method, params = {}, sessionId) {
      id += 1;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify(payload));
      });
    },
    on(fn) { listeners.push(fn); }
  };
}

try {
  const wsUrl = await target();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const client = cdp(ws);

  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });

  const logs = [];
  client.on(msg => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(msg.params.type + ': ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
  });

  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: Number(width) < 500
  }, sessionId);

  await client.send('Page.navigate', { url }, sessionId);
  await new Promise(resolve => {
    const done = msg => {
      if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') {
        client.on(() => {});
        resolve();
      }
    };
    client.on(done);
    setTimeout(resolve, 15000);
  });
  await sleep(1200);

  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: fullPage === 'true'
  }, sessionId);
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`saved ${out} (${width}x${height}${fullPage === 'true' ? ' full' : ''})`);
  if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
  ws.close();
} catch (error) {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  fs.rmSync(profile, { recursive: true, force: true });
}
