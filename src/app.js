// App bootstrap: wire config -> DB/store -> Google Map -> PWA install.
import { loadGoogleMaps, createMap, applyMapStyle } from "./maps.js";
import * as store from "./store.js";
import { Zones } from "./zones.js";
import { MapFeatures } from "./features.js";
import { Layers } from "./layers.js";
import { Hider } from "./hider.js";
import { Games } from "./games.js";
import { toast } from "./ui.js";

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
    const layers = new Layers(map, { boundaries });
    const hider = new Hider(map);
    await Promise.all([zones.init(), features.init()]);
    // Reusable custom library (Phase 9): custom categories + pins. Attached to
    // layers so the tool flows can offer them, and to games for the menu manager.
    const { Library } = await import("./library.js");
    const library = new Library(map, layers);
    layers.library = library;
    // Multiplayer sync (Phase 13): only active if a backend URL is configured;
    // otherwise it's inert and the menu shows "not configured".
    let sync = null;
    try {
      const { Sync } = await import("./sync.js");
      sync = new Sync();
      sync.init();
    } catch (e) {
      console.warn("Multiplayer sync unavailable:", e);
    }
    const games = new Games(zones, { boundaries, features, library, sync });
    layers.init();
    hider.init(sync); // pass sync so the hider zone is redacted on seeker devices

    // When the game itself changes (new / open / delete→fresh), wipe overlays
    // from modules that don't re-render on every store update, so nothing lingers
    // between games. Zones, layers and hider already clear on each store change;
    // boundary reference overlays persist WITHIN a game and are cleared here only
    // on an actual game switch (id change), never on a normal question update.
    let lastGameId = store.getCurrent()?.id || null;
    store.subscribe((g) => {
      const id = g?.id || null;
      if (id !== lastGameId) {
        lastGameId = id;
        boundaries?.clear();
        features.clearAll();
      }
    });

    // Transit on by default — hiders often stay near transit lines, so seekers
    // want the layer visible without having to find the toggle first.
    features.setTransit(true);
    document.querySelector('#toolbar [data-act="transit"]')?.classList.add("active");

    wireToolbar(zones, features, layers, hider);
    document.getElementById("menu-btn")?.addEventListener("click", () => games.openMenu());
    zones.fitToArea();
    window.__jltg = { zones, features, layers, hider, games, boundaries, library, sync, store }; // debug / testing handle
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
function wireToolbar(zones, features, layers, hider) {
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
    else if (act === "hider") hider.openPanel(layers);
    else if (act === "directions") features.openDirections(layers);
    else if (act === "transit") setActive("transit", features.toggleTransit());
    else if (act === "measure") setActive("measure", features.toggleMeasure());
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
