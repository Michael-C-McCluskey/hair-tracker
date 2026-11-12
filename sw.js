/* Hair Track service worker — cache the app shell for offline use. */
const CACHE = "hair-track-v5";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/db.js",
  "./js/app.js",
  "./js/sweep.js",
  "./vendor/jszip.min.js",
  "./fonts/plus-jakarta-sans.woff2",
  "./fonts/plus-jakarta-sans-latin-ext.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(ASSETS.map((path) => new Request(path, { cache: "reload" })));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isMediaPipe = url.pathname.includes("/vendor/mediapipe/");
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      // Large wasm/model: cache-first after the first successful fetch (lazy cache).
      if (isMediaPipe && cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        if (cached) return cached;
        if (req.mode === "navigate") {
          const shell = await cache.match("./index.html") || await cache.match("./");
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});
