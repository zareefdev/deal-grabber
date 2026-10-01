// Gives the push endpoints the storage and the secret they need, using the same
// CLOUDFLARE_API_TOKEN the deploy already holds — so there is no dashboard step.
//
//   npm run provision
//
// .github/workflows/refresh.yml runs this just before `wrangler pages deploy`. Every
// step is idempotent, so it can run on every deploy:
//
//   1. find (or create) the KV namespace that backs /api/push/subscribe
//   2. bind it to the project as SUBS by writing the binding into wrangler.toml,
//      which the deploy then hands to the Pages Functions
//   3. store PUSH_ADMIN_SECRET as a Pages secret, which gates the subscriber list
//      that the daily sender reads back
//
// Without all three /api/push/key reports ready:false and the opt-in stays hidden,
// because a subscription nobody can store or read is worse than no prompt at all.
//
// Environment:
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   required
//   PUSH_ADMIN_SECRET                             required to gate the sender
//   PAGES_PROJECT (deal-grabber), PUSH_KV_TITLE (deal-grabber-SUBS)   optional
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'wrangler.toml');

const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const PROJECT = process.env.PAGES_PROJECT || 'deal-grabber';
const TITLE = process.env.PUSH_KV_TITLE || 'deal-grabber-SUBS';
const BINDING = 'SUBS';
const ADMIN_SECRET = process.env.PUSH_ADMIN_SECRET || '';

// Marks the table this script owns, so a re-run replaces it instead of stacking a
// second SUBS binding on top (wrangler rejects a duplicate binding name).
const MARKER = '# --- push storage, written by scripts/provision-push.mjs ---';

// The deploy is meant to survive a missing KV scope (the feed must still ship), but
// that also means the failure hides inside a green run. Mirror the outcome onto the
// run page so a dead push is visible without reading the step log.
function summarise(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try { appendFileSync(file, `${lines.join('\n')}\n`); } catch {}
}

// Cloudflare answers with a success:false envelope alongside the HTTP status; the
// first error message names the actual problem (a missing scope, say) instead of
// leaving a bare "403".
async function cf(endpoint, { method = 'GET', body } = {}) {
  const response = await fetch(`${API}${endpoint}`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const detail = (payload.errors || []).map(error => error.message || error.code).join('; ');
    throw new Error(`${method} ${endpoint} → ${detail || `HTTP ${response.status}`}`);
  }
  return payload.result;
}

async function ensureNamespace() {
  const namespaces = await cf(`/accounts/${ACCOUNT}/storage/kv/namespaces?per_page=100`);
  const existing = (namespaces || []).find(namespace => namespace.title === TITLE);
  if (existing) {
    console.log(`[provision] KV namespace "${TITLE}" already exists (${existing.id})`);
    return existing;
  }
  const created = await cf(`/accounts/${ACCOUNT}/storage/kv/namespaces`, { method: 'POST', body: { title: TITLE } });
  console.log(`[provision] created KV namespace "${TITLE}" (${created.id})`);
  return created;
}

// Drops the marker and the table under it, plus any hand-added [[kv_namespaces]]
// table, so the block below stays the only thing that binds SUBS.
function withoutKvTables(toml) {
  const kept = [];
  let dropping = false;
  for (const line of toml.split('\n')) {
    if (line.trim() === MARKER || /^\s*\[\[kv_namespaces\]\]/.test(line)) {
      dropping = true;
      continue;
    }
    if (dropping) {
      // The table's own keys, and the blank line before the next table.
      if (/^\s*[a-z_]+\s*=/.test(line) || line.trim() === '') continue;
      dropping = false;
    }
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function bindInConfig(id) {
  const toml = readFileSync(configPath, 'utf8');
  writeFileSync(configPath, `${withoutKvTables(toml)}\n\n${MARKER}\n[[kv_namespaces]]\nbinding = "${BINDING}"\nid = "${id}"\n`);
  console.log(`[provision] bound ${BINDING} → ${id} in wrangler.toml, for the deploy to pick up`);
}

function storeAdminSecret() {
  // Re-setting a secret with the same value is a no-op; wrangler reads the value from
  // stdin so it never reaches the log.
  execFileSync('npx', ['--yes', 'wrangler', 'pages', 'secret', 'put', 'PUSH_ADMIN_SECRET', `--project-name=${PROJECT}`], {
    cwd: root,
    input: `${ADMIN_SECRET}\n`,
    stdio: ['pipe', 'inherit', 'inherit']
  });
  console.log('[provision] stored PUSH_ADMIN_SECRET as a Pages secret');
}

// The two halves are independent — storing the Pages secret is worth doing even when
// the token cannot reach KV — so each reports on its own and the run fails only at the
// end, naming the permission the token is missing.
async function main() {
  if (!TOKEN || !ACCOUNT) {
    console.log('::warning::CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are not set — leaving push storage unconfigured.');
    summarise(['## Deal alerts', '', '- ⏭️ **Not provisioned** — this run had no Cloudflare credentials.']);
    return;
  }

  const failures = [];

  try {
    bindInConfig((await ensureNamespace()).id);
  } catch (error) {
    failures.push(`KV namespace: ${error.message} — the CLOUDFLARE_API_TOKEN needs "Workers KV Storage: Edit" on the account to create it`);
  }

  if (!ADMIN_SECRET) {
    console.log('::warning::PUSH_ADMIN_SECRET is not set — the daily sender could not read the subscriber list.');
  } else {
    try {
      storeAdminSecret();
    } catch (error) {
      failures.push(`Pages secret: ${error.message} — the CLOUDFLARE_API_TOKEN needs "Cloudflare Pages: Edit" on the project to store it`);
    }
  }

  if (!failures.length) {
    console.log('[provision] push storage is ready.');
    summarise(['## Deal alerts', '', '- ✅ **Ready** — KV bound as `SUBS` and `PUSH_ADMIN_SECRET` stored.']);
    return;
  }
  for (const failure of failures) console.error(`[provision] ${failure}`);
  summarise([
    '## Deal alerts',
    '',
    '- ❌ **Not provisioned** — the opt-in prompt stays hidden and the daily digest sends to nobody.',
    '',
    ...failures.map(failure => `- ${failure}`)
  ]);
  process.exitCode = 1;
}

main().catch(error => {
  console.error(`[provision] ${error.message}`);
  process.exitCode = 1;
});
