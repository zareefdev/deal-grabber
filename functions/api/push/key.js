// GET /api/push/key — the application server key the browser needs to create a
// push subscription. It is a public value; serving it (rather than committing it in
// index.html) keeps the matching private key in one place: the CI secret used by
// scripts/send-daily-push.js.
//
// `ready` is true only when a subscription can actually be stored (key present and
// the SUBS namespace bound). The page leaves the alerts prompt hidden until then, so
// a user is never asked to allow notifications the daily job could not act on.
export async function onRequestGet({ env }) {
  const key = env.VAPID_PUBLIC_KEY || '';
  const ready = Boolean(key) && Boolean(env.SUBS);
  return new Response(JSON.stringify({ key, ready }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': ready ? 'public, max-age=3600' : 'no-store'
    }
  });
}
