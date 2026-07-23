import type { CapacitorConfig } from "@capacitor/cli";

// Phase 39 (Stage 5): Capacitor Android shell.
//
// The app is a WebView that loads the LIVE hosted site rather than bundled
// assets: the game already needs a network for map tiles + the relay, so
// requiring one at launch costs nothing, and every web deploy reaches the app
// with no APK rebuild. The bundled `capacitor-www/offline.html` is the ONLY
// local asset — the "no connection" fallback shown when the remote is
// unreachable.
//
// Re-pointed from GitHub Pages to Render (2026-07-23): unlike Pages, Render's
// static-site build step (render.yaml) injects GOOGLE_MAPS_API_KEY from an env
// var at deploy time, so the key served to the APK can be restricted to the
// *.onrender.com referrer in Google Cloud instead of shipping unrestricted.
// This DOES require an APK rebuild (the shell URL is baked into the native
// package) — see docs/ANDROID_BUILD.md.
//
// The background plugins (Phases 40-44: local-notifications, geofencing,
// background-geolocation, push) attach to this shell.
const config: CapacitorConfig = {
  appId: "com.pachisiav11.jltg",
  appName: "JLTG H&S",
  // Local fallback bundle. Kept tiny on purpose — it's what shows when the
  // remote site can't load, so it must not itself depend on the network.
  webDir: "capacitor-www",
  server: {
    // Load the live site. Web pushes auto-deploy here and reach the app for free.
    // NOTE: the #bgspike hash lived here through Phase 40's on-device runs (it
    // arms the diagnostic overlay in src/bg-spike.js) — now that the spike PASSED
    // and Phases 41-45 are built, a real build must NOT boot into the spike
    // screen. Append "#bgspike" yourself (in-app, via the address bar equivalent,
    // or a debug build variant) only when re-running that diagnostic.
    url: "https://jltg-map-companion.onrender.com/",
    androidScheme: "https",
    cleartext: false,
    // Shown from the bundled webDir when server.url fails to load (dead signal).
    errorPath: "offline.html",
    // Allow the WebView to navigate to the origins the app legitimately uses, so
    // the native plugin bridge stays available on the remote page. Google Maps /
    // Places / directions load under these hosts; the relay is the backend below.
    allowNavigation: [
      "jltg-map-companion.onrender.com",
      "jltg-backend.onrender.com",
      "*.onrender.com",
      "*.google.com",
      "*.googleapis.com",
      "*.gstatic.com",
    ],
  },
};

export default config;
