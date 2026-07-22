import type { CapacitorConfig } from "@capacitor/cli";

// Phase 39 (Stage 5): Capacitor Android shell.
//
// The app is a WebView that loads the LIVE GitHub Pages site rather than bundled
// assets (locked decision, BUILD_PLAN_2026-07-21.md): the game already needs a
// network for map tiles + the relay, so requiring one at launch costs nothing,
// and every web phase (27-38) reaches the app with no APK rebuild. The bundled
// `capacitor-www/offline.html` is the ONLY local asset — the "no connection"
// fallback shown when the remote is unreachable.
//
// The background plugins (Phases 40-44: local-notifications, geofencing,
// background-geolocation, push) attach to this shell; none are configured yet.
const config: CapacitorConfig = {
  appId: "com.pachisiav11.jltg",
  appName: "JLTG H&S",
  // Local fallback bundle. Kept tiny on purpose — it's what shows when the
  // remote site can't load, so it must not itself depend on the network.
  webDir: "capacitor-www",
  server: {
    // Load the live site. Web phases auto-deploy here and reach the app for free.
    url: "https://pachisiav11.github.io/JLTG-Hide-and-Seek/#bgspike",
    androidScheme: "https",
    cleartext: false,
    // Shown from the bundled webDir when server.url fails to load (dead signal).
    errorPath: "offline.html",
    // Allow the WebView to navigate to the origins the app legitimately uses, so
    // the native plugin bridge stays available on the remote page. Google Maps /
    // Places / directions load under these hosts; the relay is on Render.
    allowNavigation: [
      "pachisiav11.github.io",
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
