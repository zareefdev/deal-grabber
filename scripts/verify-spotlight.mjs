import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickSpotlight, spotlightConfig, dealPrice, feedFromSnapshot } from './lib/publish.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Use the real pipeline exactly as build-pages.mjs does it: the picker only ever sees
// rows that survived feedFromSnapshot() + publishable(), so testing anything else would
// compare a different input than production uses.
const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/deals.json'), 'utf8'));
const feed = feedFromSnapshot(snapshot);

// The build-time picker, straight from the module.
const buildPicks = pickSpotlight(feed).map(({ tag, deal }) => ({ tag, title: deal.title }));

// The runtime picker, reconstructed exactly as it is injected into the page.
const cfg = spotlightConfig();
const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/runtime.mjs'), 'utf8');
const body = src.match(/return `function pickSpotlight\(list\)\{[\s\S]*?\n\}\`;/);
if (!body) throw new Error('could not locate the runtime picker in runtime.mjs');

// The runtime picker is a template literal in runtime.mjs, so its ${...} holes have to
// be filled the same way spotlightScript() does before it can be executed here.
const forScript = s => JSON.stringify(s);
const raw = body[0].replace(/^return `/, '').replace(/`;$/, '');
const resolved = raw
  .replace(/\$\{forScript\(config\.(\w+)\)\}/g, (_, key) => forScript(cfg[key]))
  .replace(/\$\{config\.(\w+)\}/g, (_, key) => JSON.stringify(cfg[key]));

const runtimeFn = new Function(`
  const dealPrice=${dealPrice.toString()};
  ${resolved}
  return pickSpotlight;
`)();

const runtimePicks = (runtimeFn(feed) || []).map(({ tag, deal }) => ({ tag, title: deal.title }));

console.log('config keys :', Object.keys(cfg).join(', '));
console.log('build   ->', JSON.stringify(buildPicks, null, 0));
console.log('runtime ->', JSON.stringify(runtimePicks, null, 0));

const same = JSON.stringify(buildPicks) === JSON.stringify(runtimePicks);
const brands = buildPicks.map(p => p.tag.toLowerCase());
console.log('apple slot :', brands.some(t => /apple/.test(t)) ? 'yes' : 'NO');
console.log('samsung slot:', brands.some(t => /samsung/.test(t)) ? 'yes' : 'NO');
console.log(same ? '\nMATCH — build-time and runtime pick identically' : '\nDIVERGED — the hero would change after a live refresh');
process.exitCode = same ? 0 : 1;
