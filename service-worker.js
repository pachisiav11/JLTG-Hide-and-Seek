// Offline app-shell cache. Bump CACHE_VERSION whenever shell assets change.
const CACHE_VERSION = "jltg-shell-v21";

// Local shell assets only. We deliberately never cache Google Maps / API
// responses (they must stay live for transit times, Places, directions).
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./styles/main.css",
  "./vendor/turf.min.js",
  "./src/app.js",
  "./src/maps.js",
  "./src/db.js",
  "./src/model.js",
  "./src/store.js",
  "./src/geo.js",
  "./src/ui.js",
  "./src/zones.js",
  "./src/features.js",
  "./src/tools.js",
  "./src/layers.js",
  "./src/places.js",
  "./src/boundaries.js",
  "./src/data/linear.js",
  "./src/data/questions.js",
  "./src/hider.js",
  "./src/games.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never intercept Google/gstatic (maps, tiles, APIs) or our git-ignored config.
  const isGoogle = /(^|\.)google(apis)?\.com$/.test(url.hostname) || /gstatic\.com$/.test(url.hostname);
  const isConfig = url.pathname.endsWith("/config.js");
  if (isGoogle || isConfig) return; // let the network handle it

  // Same-origin shell: NETWORK-FIRST so an online device always gets the latest
  // build (each pushed phase), updating the cache as it goes; fall back to the
  // cache only when offline. This keeps the app installable/offline-capable
  // without ever serving a stale shell while connected.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          // Only cache successful, complete responses. Caching a transient 404
          // (e.g. a module fetched mid-deploy) or an opaque/partial response
          // could otherwise brick a later offline load.
          if (resp.ok && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match(request).then((c) => c || caches.match("./index.html")))
    );
  }
});
