// ============================================================================
// sw.js — Service Worker per Motion Sense Lab.
//
// Strategia: cache-first per gli asset statici. L'app è 100% statica e deve
// funzionare offline dopo il primo caricamento. Aggiorniamo il cache version
// a ogni release per invalidare le copie vecchie.
//
// Comportamento:
//   - install  → precache di tutti gli asset elencati in PRECACHE
//   - activate → pulizia di cache con versioni precedenti
//   - fetch    → match in cache; se manca, fallback a network e clona in cache
//                (solo per richieste GET same-origin).
// ============================================================================

const VERSION = 'msl-v5';
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/utils.js',
  './js/permissions.js',
  './js/gauge.js',
  './js/ppg.js',
  './js/store.js',
  './js/modules/dashboard.js',
  './js/modules/movement.js',
  './js/modules/fall.js',
  './js/modules/steps.js',
  './js/modules/sound.js',
  './js/modules/heart.js',
  './js/modules/stress.js',
  './js/modules/breath.js',
  './js/modules/info.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // addAll fa fail-fast se anche un solo asset non risponde 200:
    // utile in sviluppo per accorgersi di path sbagliati.
    await cache.addAll(PRECACHE);
    // Attiva subito il nuovo SW senza aspettare il refresh delle tab.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Solo GET e same-origin; ignora le richieste cross-origin (es. CDN, telemetria
  // di terze parti) — l'app non ne fa, ma è una buona pratica difensiva.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      // Memorizziamo solo risposte ok per evitare di "congelare" errori.
      if (fresh && fresh.ok && fresh.type === 'basic') {
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      // Offline + non in cache → fallback grazioso all'index (SPA-style).
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
      throw err;
    }
  })());
});
