// App bootstrap: wire config -> DB/store -> Google Map -> PWA install.
import { loadGoogleMaps, createMap, applyMapStyle } from "./maps.js";
import * as store from "./store.js";
import { Zones } from "./zones.js";
import { MapFeatures } from "./features.js";
import { Layers } from "./layers.js";
import { Focus } from "./focus.js";
import { Geofence } from "./geofence.js";
import { StationsLayer } from "./stations-layer.js";
import { Notes } from "./notes.js";
import { LiveShare } from "./live-share.js";
import { geoWatch } from "./geo-watch.js";
import { SelfLocation } from "./self-location.js";
import { GpsStatus } from "./gps-status.js";
import { SeekerDot } from "./seeker-dot.js";
import { Lines } from "./lines.js";
import { Games } from "./games.js";
import { toast } from "./ui.js";
import * as db from "./db.js";

// A cheap identity for "which board is this". Rail lines are fetched for the board's bbox, so
// what matters is whether that extent moved — not which zone changed or how it was edited.
function boardKey(g) {
  const a = g?.gameArea;
  if (!a) return "none";
  try {
    const b = window.turf?.bbox(window.turf.feature(a));
    return b ? b.map((n) => n.toFixed(4)).join(",") : "unknown";
  } catch (_) { return "unknown"; }
}

const boot = document.getElementById("boot");
const bootMsg = document.getElementById("boot-msg");
const bootDetail = document.getElementById("boot-detail");
const bootCard = boot?.querySelector(".boot-card");
const gameNameEl = document.getElementById("game-name");

const LS_API_KEY = "jltg.apiKey";
const LS_MAP_ID = "jltg.mapId";
const DEFAULTS = { center: { lat: 1.2830, lng: 103.8590 }, zoom: 12 };

function setBoot(msg, detail = "", isError = false) {
  if (bootMsg) bootMsg.textContent = msg;
  if (bootDetail) {
    bootDetail.textContent = detail;
    bootDetail.classList.toggle("error", isError);
  }
}

function hideBoot() {
  boot?.classList.add("hidden");
  setTimeout(() => boot?.remove(), 500);
}

// Resolve the API key from (1) local git-ignored config.js, or (2) this device's
// localStorage (entered once via the setup screen — used for hosted/phone builds).
function resolveConfig() {
  const file = window.JLTG_CONFIG || {};
  const fileKey = file.GOOGLE_MAPS_API_KEY;
  const key =
    fileKey && fileKey !== "YOUR_API_KEY_HERE"
      ? fileKey
      : localStorage.getItem(LS_API_KEY) || null;
  // Optional vector Map ID (for official DDS region boundaries): git-ignored
  // config.js, else this device's Settings-entered value. Not committed to git
  // — each device supplies its own, same as the API key.
  const fileMapId = file.MAP_ID;
  const mapId =
    (fileMapId && fileMapId !== "YOUR_MAP_ID_HERE" && fileMapId) ||
    localStorage.getItem(LS_MAP_ID) ||
    null;
  return {
    key,
    keyFromStorage: !(fileKey && fileKey !== "YOUR_API_KEY_HERE") && !!key,
    mapId,
    center: file.DEFAULT_CENTER || DEFAULTS.center,
    zoom: file.DEFAULT_ZOOM || DEFAULTS.zoom,
  };
}

// One-time key-entry screen shown when no key is present (e.g. first run on a phone).
// Also offers an OPTIONAL Map ID field (for exact region boundaries) on the same
// screen — it's not required to continue, and can be added/changed later in Settings.
function promptForKey() {
  return new Promise((resolve) => {
    if (!bootCard) return resolve(null);
    setBoot("Set up your map key", "");
    const form = document.createElement("form");
    form.className = "setup";
    form.innerHTML = `
      <p class="setup-hint">Paste your Google Maps Platform API key. It is stored only on this device.</p>
      <input id="setup-key" type="text" inputmode="text" autocomplete="off" autocapitalize="off"
             spellcheck="false" placeholder="AIza…" aria-label="API key" />
      <p class="setup-hint">Optional — a vector Map ID for exact region boundaries (🌍 Region boundary). Leave blank for an approximate box; you can add/change this later in Settings.</p>
      <input id="setup-mapid" type="text" inputmode="text" autocomplete="off" autocapitalize="off"
             spellcheck="false" placeholder="Map ID (optional)" aria-label="Map ID (optional)" />
      <button type="submit">Save &amp; continue</button>
      <a class="setup-help" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Get a key ↗</a>
    `;
    const input = form.querySelector("#setup-key");
    const mapIdInput = form.querySelector("#setup-mapid");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return;
      localStorage.setItem(LS_API_KEY, val);
      const mapId = mapIdInput.value.trim();
      if (mapId) localStorage.setItem(LS_MAP_ID, mapId);
      form.remove();
      resolve(val);
    });
    bootCard.appendChild(form);
    input.focus();
  });
}

async function main() {
  // 1) Resolve config; prompt for a key if none is available on this device.
  let cfg = resolveConfig();
  if (!cfg.key) {
    await promptForKey();
    cfg = resolveConfig();
  }

  // 2) Local storage / current game.
  setBoot("Loading your game…");
  let game;
  try {
    game = await store.init();
    reflectGame(game);
    store.subscribe(reflectGame);
  } catch (e) {
    console.error(e);
    setBoot("Storage error", String(e.message || e), true);
    return;
  }

  // 3) Google Maps (key-critical — a failure here usually means a bad key).
  setBoot("Loading map…");
  let map;
  try {
    await loadGoogleMaps(cfg.key);
    map = await createMap(document.getElementById("map"), {
      center: cfg.center,
      zoom: cfg.zoom,
      mapId: cfg.mapId,
    });
    window.__jltgMap = map; // handy for debugging / later phases
    // Base map style (Phase 12): device-level preference. Applied now and whenever
    // Settings dispatches a change. Dark style is a no-op under a vector Map ID.
    applyMapStyle(map, localStorage.getItem("jltg.mapStyle") || "roadmap", { hasMapId: !!cfg.mapId });
    window.addEventListener("jltg:mapstyle", (e) => {
      const warn = applyMapStyle(map, e.detail || "roadmap", { hasMapId: !!cfg.mapId });
      if (warn) toast(warn, 5000);
    });
  } catch (e) {
    console.error(e);
    // Only a device-entered key is worth discarding; a config.js key stays put.
    if (cfg.keyFromStorage) {
      localStorage.removeItem(LS_API_KEY);
      setBoot("Map failed to load", String(e.message || e) + " — reload to re-enter your key.", true);
    } else {
      setBoot("Map failed to load", String(e.message || e), true);
    }
    return;
  }

  // 4) Zones + native map features. A failure here must NOT block the map or key.
  try {
    // Region-boundary overlays are optional; load them non-fatally so a problem
    // with this one module can never block the whole app from booting.
    let boundaries = null;
    try {
      const { Boundaries } = await import("./boundaries.js");
      boundaries = new Boundaries(map, { ddsAvailable: !!cfg.mapId });
    } catch (e) {
      console.warn("Region-boundary overlays unavailable:", e);
    }
    const zones = new Zones(map, boundaries);
    const features = new MapFeatures(map);
    const focus = new Focus(map);
    // Constructed before Layers because the Matching line card hands the player straight to
    // this panel when the board's rail set is too large to answer (P4).
    const lines = new Lines(map);
    const layers = new Layers(map, { boundaries, lines });
    await Promise.all([zones.init(), features.init()]);
    // Reusable custom library (Phase 9): custom categories + pins. Attached to
    // layers so the tool flows can offer them, and to games for the menu manager.
    const { Library } = await import("./library.js");
    const library = new Library(map, layers);
    layers.library = library;
    // Phase 12 (§C5): live seeker→hider location share. Transport is a lazy
    // Socket.IO client loaded from the backend when the user actually opens
    // the panel — otherwise a fresh boot pays for zero of the sharing infra
    // if it's never used. See games.js openLiveShare for the wire-up.
    // onError surfaces server-side session-error as a toast so a mistyped code
    // isn't invisible if the user was looking at the map instead of the pill.
    // Declared before Games so it can be handed in without hitting the TDZ.
    // Phase 37 (req #7b): draw the live seeker as a red dot on the hider's map.
    // LiveShare hands each ping's point (and null on disconnect) to the dot.
    const seekerDot = new SeekerDot(map);
    const liveShare = new LiveShare({ transport: null, watch: geoWatch, onSeekerPoint: (pt) => seekerDot.update(pt), onError: (msg) => toast(`Live share: ${msg}`, 4000) });
    const games = new Games(zones, { boundaries, features, library, map, lines, liveShare, layers });
    layers.init();
    focus.init();
    // Hider geofence (Phase 3 / A1): watches GPS against the focus zone edge and fires
    // notifications when the hider drifts near or across it. Inert until the seeker
    // sets a geofence threshold in Settings AND a focus zone exists.
    const geofence = new Geofence({ watch: geoWatch });
    geofence.init();
    // Phase 36 (req #7a): the always-on blue self-dot + accuracy ring, riding the
    // same shared GeoWatch as the geofence and seeker (one OS watch for all three).
    const selfLocation = new SelfLocation(map, { watch: geoWatch });
    selfLocation.init();
    // Phase 35 (req #5): the shared "📍 Location on" chip, shown to both roles
    // whenever any foreground GPS watch is active (which, with the self-dot, is
    // whenever location permission is granted).
    const gpsStatus = new GpsStatus({ watch: geoWatch });
    gpsStatus.init();
    // Phase 6 (A3): render the locked station set as tappable markers so
    // manually eliminating a station is a one-tap map interaction, not a
    // panel scroll. Reuses game.stations.list (Phase 1) and the eliminated
    // flag + eliminatedBy tag (Phase 4).
    const stationsLayer = new StationsLayer(map);
    stationsLayer.init();
    // Phase 31 (req #1): the Stations panel's "Select on map" hands the tapped
    // point to the layer's chooser; wire the reference now that both exist.
    games.stationsLayer = stationsLayer;
    // Phase 10 (§C1): long-press map → note pin. Captures off-app clues
    // (playtest 1 Q4 photo case, ambient observations) into per-game map
    // state instead of losing them in a WhatsApp thread.
    const notes = new Notes(map);
    notes.init();

    // When the game itself changes (new / open / delete→fresh), wipe overlays
    // from modules that don't re-render on every store update, so nothing lingers
    // between games. Zones and layers already clear on each store change;
    // boundary reference overlays persist WITHIN a game and are cleared here only
    // on an actual game switch (id change), never on a normal question update.
    let lastGameId = store.getCurrent()?.id || null;
    let lastAreaKey = boardKey(store.getCurrent());
    store.subscribe((g) => {
      const id = g?.id || null;
      if (id !== lastGameId) {
        lastGameId = id;
        lastAreaKey = boardKey(g);
        boundaries?.clear();
        features.clearAll();
        // Lines are fetched for a specific board bbox, so they are meaningless on the next
        // game — and stale rail drawn over a different city is worse than none.
        lines.clear();
        document.querySelector('#toolbar [data-act="rail"]')?.classList.remove("active");
        return;
      }
      // Same game, different BOARD. Rail was fetched for the old extent, so it stops short of
      // any ground just added — indistinguishable from OSM having no lines there. This was
      // never wired up, so the overlay stayed stale for the life of the game.
      const areaKey = boardKey(g);
      if (areaKey !== lastAreaKey) {
        lastAreaKey = areaKey;
        if (lines.invalidate()) {
          document.querySelector('#toolbar [data-act="rail"]')?.classList.remove("active");
          // Deferred, because this fires from INSIDE store.update — the caller (addZone,
          // removeZone) toasts its own confirmation immediately afterwards, and `toast` is a
          // single element, so an immediate message here is overwritten before it can be read.
          // Measured: it never appeared at all. The zone confirmation comes first, then this.
          setTimeout(() => toast("The board changed — reopen 🚄 to reload rail lines for the new area."), 2600);
        }
      }
    });

    // Transit on by default — hiders often stay near transit lines, so seekers want the layer
    // visible without having to find the toggle first, and it is instant where 🚄 Rail is a
    // slow fetch that fails ~64% of the time.
    //
    // But it is the INCOMPLETE source: raster tiles from Google's own feed inventory, drawing
    // Mumbai's Metro and not its suburban locals — the lines that decide the game, and the
    // reason the Overpass pipeline exists. Shipping the known-incomplete layer as the thing a
    // player sees without asking is only defensible if they are told, so say it once per
    // install rather than never (toggling it says so every time; see features.toggleTransit).
    features.setTransit(true);
    document.querySelector('#toolbar [data-act="transit"]')?.classList.add("active");
    db.getSetting("transitCaveatSeen", false).then((seen) => {
      if (seen) return;
      // After boot settles, so it does not land under the restore/zone toasts.
      setTimeout(() => toast("🚆 Transit is Google's layer and misses some agencies. 🚄 Rail loads the full network from OpenStreetMap.", 6000), 3000);
      db.setSetting("transitCaveatSeen", true);
    }).catch(() => { /* settings unavailable — the tooltip and the toggle still say it */ });

    wireToolbar(zones, features, layers, focus, lines);
    document.getElementById("menu-btn")?.addEventListener("click", () => games.openMenu());
    zones.fitToArea();
    window.__jltg = { zones, features, layers, focus, geofence, selfLocation, gpsStatus, seekerDot, stationsLayer, notes, liveShare, lines, games, boundaries, library, store }; // debug / testing handle
  } catch (e) {
    console.error("tool init failed", e);
    toast("Some map tools failed to load — see console.");
  }

  hideBoot();
}

function reflectGame(game) {
  if (gameNameEl && game) gameNameEl.textContent = game.name || "";
}

// Wire the floating toolbar to zone + feature actions.
function wireToolbar(zones, features, layers, focus, lines) {
  const bar = document.getElementById("toolbar");
  if (!bar) return;
  const setActive = (act, on) =>
    bar.querySelector(`[data-act="${act}"]`)?.classList.toggle("active", on);

  bar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "zones") zones.openPanel();
    else if (act === "layers") layers.openPanel();
    else if (act === "focus") focus.openPanel(layers);
    else if (act === "directions") features.openDirections(layers);
    else if (act === "transit") setActive("transit", features.toggleTransit());
    else if (act === "measure") setActive("measure", features.toggleMeasure());
    // Opens a panel rather than toggling: which modes and lines are in play is a per-board
    // decision (a tram is a real way to travel; whether it counts is the player's call), so
    // this needs more than one bit. The first press fetches from Overpass — slow, and it
    // fails often — after which filtering is local and instant.
    else if (act === "rail") {
      lines.openPanel(store.getCurrent()?.gameArea).then(() => setActive("rail", lines.isOn()));
    }
    else if (act === "locate") {
      if (store.getCurrent()?.zones?.length) zones.fitToArea();
      else toast("No zones yet — add one from the Zones tool.");
    }
  });
}

// --- PWA: service worker + install prompt ---------------------------------
// Phase 12: instead of silently swapping to a new build, a new service worker
// WAITS and we surface a visible "Update available — Reload" banner. Clicking it
// tells the waiting worker to skipWaiting; controllerchange then reloads once, so
// players never unknowingly run a stale cached version mid-game.
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol === "file:") return; // no SW on file://
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./service-worker.js");
      // A worker already waiting from a previous visit → prompt straight away.
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          // "installed" while a controller exists = an UPDATE (not first install).
          if (nw.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner(nw);
        });
      });
    } catch (e) {
      console.warn("SW registration failed:", e);
    }
  });
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

function showUpdateBanner(worker) {
  if (document.getElementById("update-banner")) return;
  const bar = document.createElement("div");
  bar.id = "update-banner";
  bar.className = "update-banner";
  bar.innerHTML = `<span>New version available.</span>
    <button class="btn btn-primary btn-sm" id="ub-reload">Reload</button>
    <button class="update-x" aria-label="Dismiss">✕</button>`;
  document.body.appendChild(bar);
  bar.querySelector("#ub-reload").onclick = () => { bar.remove(); worker.postMessage({ type: "SKIP_WAITING" }); };
  bar.querySelector(".update-x").onclick = () => bar.remove();
}

function wireInstallPrompt() {
  const installBtn = document.getElementById("install-btn");
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    if (installBtn) installBtn.hidden = false;
  });
  installBtn?.addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    installBtn.hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    if (installBtn) installBtn.hidden = true;
  });
}

registerServiceWorker();
wireInstallPrompt();
main();
