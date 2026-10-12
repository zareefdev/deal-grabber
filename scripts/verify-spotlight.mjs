import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickSpotlight, spotlightConfig, dealPrice, feedFromSnapshot } from './lib/publish.mjs';
import { spotlightScript } from './lib/runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Use the real pipeline exactly as build-pages.mjs does it: the picker only ever sees
// rows that survived feedFromSnapshot() + publishable(), so testing anything else would
// compare a different input than production uses.
const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/deals.json'), 'utf8'));
const feed = feedFromSnapshot(snapshot);

// The build-time picker, straight from the module.
const buildPicks = pickSpotlight(feed).map(({ tag, deal }) => ({ tag, title: deal.title }));

// The runtime picker, compiled from the exact string the page embeds. spotlightScript()
// returns the *evaluated* template, so the backslashes in its regexes are real; pulling
// the raw template source out with a regex instead double-escaped every \s, which broke
// the variant-collapsing base() regex and reported a false divergence the moment a feed
// carried colour/storage variants of one product.
const cfg = spotlightConfig();
const runtimeFn = new Function(`
  const dealPrice=${dealPrice.toString()};
  ${spotlightScript()}
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
