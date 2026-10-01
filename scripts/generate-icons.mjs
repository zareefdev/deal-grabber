// Renders the PWA icon set from the same arrow mark as public/favicon.svg.
// Icons are committed as PNGs, so this only has to run when the mark changes:
//
//   npm install
//   npm run icons
//
// It uses the Playwright that is already a dependency of this project. If the
// installed Playwright build asks for a Chromium revision the machine does not
// hold, set PLAYWRIGHT_MODULE_PATH / PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

const GREEN = '#c5f36b';
const INK = '#243512';
const MARK = 'M20 44 L44 20 M44 20 H30 M44 20 V34';

// bleed: full-bleed square (maskable / iOS paint their own mask and dislike
// transparency). arrow: fraction of the 64-unit box the mark occupies — maskable
// keeps it inside the 80% safe zone. badge: transparent glyph-only image for the
// Android notification badge, so it draws white with no plate behind it.
const ICONS = [
  { file: 'icon-192.png', dir: 'icons', size: 192, bleed: false, arrow: 1 },
  { file: 'icon-512.png', dir: 'icons', size: 512, bleed: false, arrow: 1 },
  { file: 'maskable-512.png', dir: 'icons', size: 512, bleed: true, arrow: 0.6 },
  { file: 'badge-72.png', dir: 'icons', size: 72, badge: true, arrow: 1 },
  { file: 'apple-touch-icon.png', dir: '', size: 180, bleed: true, arrow: 0.66 }
];

function markSvg({ bleed, arrow, badge }) {
  const pad = (64 * (1 - arrow)) / 2;
  const radius = bleed ? 0 : 16;
  const stroke = badge ? '#ffffff' : INK;
  const arrowGroup = arrow === 1
    ? `<path d="${MARK}" fill="none" stroke="${stroke}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<g transform="translate(${pad} ${pad}) scale(${arrow})"><path d="${MARK}" fill="none" stroke="${stroke}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  const plate = badge ? '' : `<rect width="64" height="64" rx="${radius}" fill="${GREEN}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  ${plate}
  ${arrowGroup}
</svg>`;
}

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE_PATH, 'playwright'].filter(Boolean);
  for (const name of candidates) {
    try { return require(name); } catch {}
  }
  return null;
}

// Same cache walk as server.js: pick a Chromium the machine already downloaded.
function resolveChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const roots = [
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright'),
    process.env.PLAYWRIGHT_BROWSERS_PATH
  ].filter(Boolean);
  const rels = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win/chrome.exe'
  ];
  for (const rootDir of roots) {
    let dirs = [];
    try { dirs = readdirSync(rootDir).filter(n => /^chromium-\d+$/.test(n)); } catch { continue; }
    dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const dir of dirs) {
      for (const rel of rels) {
        const candidate = path.join(rootDir, dir, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

const playwright = loadPlaywright();
if (!playwright) {
  console.error('Playwright not found. Run `npm install` first (or set PLAYWRIGHT_MODULE_PATH).');
  process.exit(1);
}

mkdirSync(path.join(publicDir, 'icons'), { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: resolveChromium() });

for (const icon of ICONS) {
  const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;width:100%;height:100%;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${markSvg(icon)}`,
    { waitUntil: 'load' }
  );
  const target = path.join(publicDir, icon.dir, icon.file);
  await page.screenshot({ path: target, omitBackground: Boolean(icon.badge) || !icon.bleed });
  await page.close();
  console.log(`[icons] ${icon.dir ? `${icon.dir}/` : ''}${icon.file} (${icon.size}px)`);
}

await browser.close();
console.log(`[icons] wrote ${ICONS.length} icons`);
