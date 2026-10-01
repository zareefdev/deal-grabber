/* Amazon to Flipkart Deals Grabber — service worker.
 *
 * Two jobs:
 *   1. PWA shell: keep the page installable and readable offline (cached shell
 *      plus the last good deal snapshot).
 *   2. Web push: render notifications sent by the daily job and route a click
 *      back into the live feed.
 *
 * Bump VERSION whenever the caching rules change so old caches are dropped.
 */
const VERSION = 'dg-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const MAX_RUNTIME_ENTRIES = 120;
const SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Individual adds: one missing asset must not abort the whole precache.
    await Promise.allSettled(SHELL.map(url => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => !key.startsWith(VERSION)).map(key => caches.delete(key)));
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

const isFont = url => /(^|\.)(googleapis|gstatic)\.com$/.test(url.hostname);
const isImage = url =>
  url.pathname.startsWith('/icons/') ||
  /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(url.pathname) ||
  /(^|\.)(media-amazon|ssl-images-amazon|flixcart)\.com$/.test(url.hostname);

async function trimRuntime() {
  const cache = await caches.open(RUNTIME_CACHE);
  const keys = await cache.keys();
  if (keys.length <= MAX_RUNTIME_ENTRIES) return;
  await Promise.all(keys.slice(0, keys.length - MAX_RUNTIME_ENTRIES).map(key => cache.delete(key)));
}

async function putInRuntime(request, response) {
  if (!response || !(response.ok || response.type === 'opaque')) return response;
  const cache = await caches.open(RUNTIME_CACHE);
  await cache.put(request, response.clone()).catch(() => {});
  trimRuntime().catch(() => {});
  return response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return; // POST /api/push/subscribe passes straight through.

  const url = new URL(request.url);
  // Push endpoints (including the VAPID key) always reach the network.
  if (url.pathname.startsWith('/api/push')) return;

  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !isFont(url) && !isImage(url)) return;

  // Navigations: network-first, then the cached shell.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        return (await caches.match(request)) ||
          (await caches.match('/index.html')) ||
          (await caches.match('/offline.html')) ||
          new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
      }
    })());
    return;
  }

  // Live feed: a fresh scrape always wins; the last good snapshot covers offline.
  if (url.pathname === '/api/deals' || url.pathname === '/deals.json') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put('/deals.json', response.clone()).catch(() => {});
        }
        return response;
      } catch {
        return (await caches.match('/deals.json')) ||
          new Response('{"amazon":{"deals":[]},"flipkart":{"deals":[]}}', {
            status: 503,
            headers: { 'content-type': 'application/json' }
          });
      }
    })());
    return;
  }

  // Product images and webfonts are immutable enough to serve cache-first.
  if (isFont(url) || isImage(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        return await putInRuntime(request, await fetch(request));
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // Everything else same-origin: stale-while-revalidate.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request).then(response => putInRuntime(request, response)).catch(() => cached);
    return cached || network;
  })());
});

// ── Web push ─────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Today’s top deals';
  const options = {
    body: data.body || 'Two handpicked Amazon & Flipkart deals are waiting.',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: data.tag || 'daily-deals',
    renotify: true,
    timestamp: Date.now(),
    data: { url: data.url || '/?utm_source=push' }
  };
  if (data.image) options.image = data.image;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const absolute = new URL(target, self.location.origin).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (client.url === absolute && 'focus' in client) return client.focus();
    }
    for (const client of windows) {
      if ('navigate' in client) {
        await client.navigate(absolute).catch(() => {});
        if ('focus' in client) return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(absolute);
  })());
});

// Browsers may rotate a subscription without telling the page; re-register it.
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const details = event.newSubscription && event.newSubscription.toJSON ? event.newSubscription.toJSON() : null;
      let subscription = details;
      if (!subscription) {
        const response = await fetch('/api/push/key', { cache: 'no-store' });
        const { key } = response.ok ? await response.json() : {};
        if (!key) return;
        const created = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key)
        });
        subscription = created.toJSON();
      }
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subscription)
      });
    } catch {}
  })());
});
