// Service Worker — SA Bitcoin Tax
// Cache-first strategy for app shell; network-first for API calls.

const CACHE = 'sabtctax-v1';

const APP_SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/blink.js',
  '/js/db.js',
  '/images/blink.svg',
  '/images/csv.svg',
  '/images/icon-192.png',
  '/images/icon-512.png',
  '/manifest.json',
];

// Install: pre-cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: purge old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for same-origin assets, network-only for external APIs
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Let external API calls (Blink, CoinGecko, Binance, ECB) go straight to network
  if (url.origin !== self.location.origin) {
    return; // browser handles it normally
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
