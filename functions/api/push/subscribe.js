// /api/push/subscribe — where the browser registers (and drops) its push endpoint.
//
//   POST   { endpoint, keys: { p256dh, auth } }   subscribe / refresh
//   DELETE ?endpoint=…                            unsubscribe
//   GET                                           list, for the daily sender only
//
// Storage is a KV namespace bound as SUBS. One key per endpoint, named by the
// SHA-256 of the endpoint URL, so re-subscribing overwrites instead of duplicating.
// Nothing here is a secret — an endpoint is useless without the matching VAPID
// private key — but the listing route is still gated: it is only reachable with the
// PUSH_ADMIN_SECRET bearer token that the daily push workflow holds.
const PREFIX = 'sub:';
const MAX_LISTED = 5000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function subscriptionId(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function isSubscription(value) {
  return Boolean(value) &&
    typeof value.endpoint === 'string' && value.endpoint.startsWith('https://') &&
    value.keys && typeof value.keys.p256dh === 'string' && typeof value.keys.auth === 'string';
}

function isAdmin(request, env) {
  const secret = env.PUSH_ADMIN_SECRET || '';
  return Boolean(secret) && request.headers.get('authorization') === `Bearer ${secret}`;
}

function unconfigured() {
  return json({ ok: false, error: 'Push storage is not configured.' }, 503);
}

export async function onRequestPost({ request, env }) {
  if (!env.SUBS) return unconfigured();

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Expected a JSON body.' }, 400);
  }

  const subscription = body && body.subscription ? body.subscription : body;
  if (!isSubscription(subscription)) return json({ ok: false, error: 'Not a valid push subscription.' }, 400);

  const record = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    createdAt: new Date().toISOString(),
    userAgent: request.headers.get('user-agent') || ''
  };

  await env.SUBS.put(PREFIX + await subscriptionId(record.endpoint), JSON.stringify(record));
  return json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  if (!env.SUBS) return unconfigured();

  let endpoint = new URL(request.url).searchParams.get('endpoint') || '';
  if (!endpoint) {
    try {
      const body = await request.json();
      endpoint = (body && (body.endpoint || (body.subscription && body.subscription.endpoint))) || '';
    } catch {}
  }
  if (!endpoint) return json({ ok: false, error: 'Missing endpoint.' }, 400);

  await env.SUBS.delete(PREFIX + await subscriptionId(endpoint));
  return json({ ok: true });
}

export async function onRequestGet({ request, env }) {
  if (!env.SUBS) return unconfigured();
  if (!isAdmin(request, env)) return json({ ok: false, error: 'Unauthorized.' }, 401);

  const subscriptions = [];
  let cursor;
  do {
    const page = await env.SUBS.list({ prefix: PREFIX, cursor });
    const values = await Promise.all(page.keys.map(key => env.SUBS.get(key.name, 'json')));
    for (const value of values) if (value) subscriptions.push(value);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && subscriptions.length < MAX_LISTED);

  return json({ ok: true, count: subscriptions.length, subscriptions });
}
