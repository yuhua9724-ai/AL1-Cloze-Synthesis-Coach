const CACHE_VERSION = 'v1.0.7';
const CACHE_NAME = 'al1-cloze-' + CACHE_VERSION;

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/')) return;
  if (e.request.url.includes('supabase.co')) return;

  // 'cache: no-store' forces a real network round-trip every time, bypassing
  // Safari's HTTP disk cache. Without this, e.request can be satisfied
  // straight from disk cache (a layer BELOW the Service Worker), so even
  // though this handler is "network-first" in intent, it was silently
  // serving stale index.html/JS on iOS Safari Home Screen apps — which
  // re-check the SW script correctly but not the page content it fetches.
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
