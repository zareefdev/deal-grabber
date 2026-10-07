/**
 * Locates a Chromium binary for the CDP-driven checkers.
 *
 * The playwright cache layout differs per platform, and CI runs on ubuntu-latest while
 * a developer runs on macOS, so the path cannot be hardcoded — a mac-only path made
 * every page check fail on the runner. Resolution order:
 *
 *   1. CHROME_PATH, when set explicitly.
 *   2. A system Chrome/Chromium/Edge on PATH.
 *   3. Any playwright-managed chromium-* build in the user cache (newest first).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = process.platform === 'win32'
  ? 'chrome.exe'
  : process.platform === 'darwin'
    ? 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    : 'chrome-linux/chrome';

const SYSTEM = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge'
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ]
};

export function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  for (const candidate of SYSTEM[process.platform] || []) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // playwright lays its downloads out as <cache>/chromium-<build>/<platform>/<exe>,
  // e.g. chrome-mac-arm64/Google Chrome for Testing.app/... on mac and
  // chrome-linux/chrome on Linux. The build number changes between releases and the
  // platform folder differs per OS, so walk the tree rather than hardcoding a layout.
  const cache = path.join(os.homedir(), process.platform === 'darwin'
    ? 'Library/Caches/ms-playwright'
    : process.platform === 'win32'
      ? 'AppData/Local/ms-playwright'
      : '.cache/ms-playwright');

  let entries = [];
  try {
    entries = fs.readdirSync(cache).filter(entry => /^chromium-\d+$/.test(entry));
  } catch {
    return null;
  }

  const EXE_NAME = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let children = [];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        walk(full, depth + 1);
      } else if (child.name === EXE_NAME || child.name === EXE) {
        found.push(full);
      }
    }
  };
  for (const entry of entries) walk(path.join(cache, entry), 0);

  // Newest build last, since playwright keeps several side by side.
  found.sort();
  return found[found.length - 1] || null;
}

export function requireChrome() {
  const bin = findChrome();
  if (!bin) {
    throw new Error(
      'no Chromium found. Install one with `npx playwright install chromium`, ' +
      'or point CHROME_PATH at a Chrome/Chromium binary.'
    );
  }
  return bin;
}
