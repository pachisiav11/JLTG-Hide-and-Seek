// Offline app-shell cache. Bump CACHE_VERSION whenever shell assets change.
const CACHE_VERSION = "jltg-shell-v79";

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
  "./src/palette.js",
  "./src/library.js",
  "./src/timer.js",
  "./src/zones.js",
  "./src/features.js",
  "./src/tools.js",
  "./src/layers.js",
  "./src/places.js",
  "./src/boundaries.js",
  "./src/data/questions.js",
  "./src/focus.js",
  "./src/geofence.js",
  "./src/stations.js",
  "./src/ingest.js",
  "./src/stations-layer.js",
  "./src/notes.js",
  "./src/live-share.js",
  "./src/lines.js",
  "./src/games.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  // Do NOT skipWaiting automatically (Phase 12): a new worker WAITS so the app can
  // show an "update available" banner; it activates only when the page asks it to.
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS))
  );
});

// The page posts this when the user clicks "Reload" on the update banner.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") return self.skipWaiting();
  // Phase 9 (§C4): a page-side geofence alert asks the SW to render the
  // notification, so the user sees it in the system tray (and the phone can
  // wake it) instead of a foreground-only `new Notification(...)` that
  // Android throws away when the tab is backgrounded.
  if (event.data?.type === "GEOFENCE_NOTIFY") {
    const { title, body, tag } = event.data;
    if (!title) return;
    try {
      self.registration.showNotification(title, {
        body: body || "",
        tag: tag || "jltg-geofence",
        renotify: true,
        icon: "./icons/icon-192.png",
        badge: "./icons/icon-192.png",
        // vibration pattern here is the fallback for when the page-side
        // navigator.vibrate call in Phase 8 couldn't run (backgrounded tab):
        // system notifications honour this pattern on Android.
        vibrate: [200, 100, 200],
      });
    } catch (e) { console.warn("SW showNotification failed", e); }
  }
});

// Clicking the notification: focus an already-open tab if any, else open one.
// Without this handler the notification is a dead end on some Android launchers
// (the tap does nothing at all).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) if (c.url && "focus" in c) return c.focus();
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
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
