/* ============================================================
   CipherHealth — Service Worker v0.6.0
   Estrategia: cache-first para archivos locales,
               stale-while-revalidate para CDN.
   ============================================================ */

const CACHE  = 'cipher-health-v0.6.0';
const PREV   = ['cipher-health-v0.5.0', 'cipher-health-v0.4.0',
                'cipher-health-v0.3.0', 'cipher-health-v0.2.0',
                'cipher-health-v0.1.0'];

// Archivos locales que se pre-cachean al instalar el SW
const PRE_CACHE = [
  './',
  './index.html',
  './styles.css',
  './db.js',
  './app.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
];

// ---- Instalación: pre-cachear archivos locales ----
self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRE_CACHE))
      .then(() => self.skipWaiting())
  );
});

// ---- Activación: borrar cachés viejas ----
self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ---- Fetch: cache-first con actualización en segundo plano ----
self.addEventListener('fetch', (ev) => {
  // Solo interceptar GET; ignorar requests chrome-extension, etc.
  if (ev.request.method !== 'GET') return;
  const url = new URL(ev.request.url);
  if (!['http:', 'https:'].includes(url.protocol)) return;

  ev.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(ev.request);

      // Lanzar fetch en background para mantener el cache fresco
      const networkFetch = fetch(ev.request)
        .then(res => {
          // Solo cachear respuestas validas
          if (res && res.ok && res.type !== 'opaque') {
            cache.put(ev.request, res.clone());
          }
          return res;
        })
        .catch(() => null);

      // Si hay algo en cache, responder de inmediato (offline funciona)
      // Si no hay cache, esperar la red
      return cached || networkFetch;
    })
  );
});
