'use strict';

// Offline support for the website ("Add to Home Screen" / "Install app").
// Network first, so a visit online always gets the latest version; the copy
// kept here is used only when the network fails. Everything the app needs,
// the MP3 encoder included, is stored at install, so it works fully offline
// from the first visit on.

const CACHE = '8d-converter';
const FILES = [
  './', 'index.html', 'app.js', 'vocals.js', 'auto.js', 'tags.js', 'style.css', 'manifest.webmanifest',
  'vendor/lamejs/lame.min.js',
  'icons/favicon.svg', 'icons/favicon-32.png', 'icons/apple-touch-icon.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    } catch (err) {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      throw err;
    }
  })());
});
