/* sw.js — Service worker de la Quiniela Mundial
 * Estrategia:
 *   - App shell (HTML/manifest/íconos): precache + cache-first.
 *   - SDK de Firebase y fuentes (CDN): cache-first en runtime.
 *   - Firestore tiene su propia persistencia offline (se activa en index.html),
 *     por eso NO interceptamos sus peticiones aquí.
 */
const CACHE = "quiniela-v3";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // No tocar Firestore / Google APIs de datos: que vayan directo a la red.
  if (
    url.hostname.includes("firestore.googleapis.com") ||
    url.hostname.includes("googleapis.com") && url.pathname.includes("/google.firestore")
  ) {
    return;
  }

  // CDN de Firebase SDK y fuentes: cache-first (sirve offline tras la 1ª carga).
  const esCDN =
    url.hostname.includes("gstatic.com") || url.hostname.includes("fonts.googleapis.com");
  if (esCDN) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
            return res;
          })
      )
    );
    return;
  }

  // App shell propio: cache-first con respaldo a index.html para navegación.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        if (hit) return hit;
        return fetch(e.request).catch(() => caches.match("./index.html"));
      })
    );
  }
});
