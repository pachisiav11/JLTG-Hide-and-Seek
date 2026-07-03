// App bootstrap: wire config -> DB/store -> Google Map -> PWA install.
import { loadGoogleMaps, createMap } from "./maps.js";
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
  // Optional vector Map ID (for official DDS region boundaries): config first,
  // else this device's Settings-entered value.
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
function promptForKey() {
  return new Promise((resolve) => {
    if (!bootCard) return resolve(null);
    setBoot("Set up your map key", "");
    const form = document.createElement("form");
    form.className = "setup";
    form.innerHTML = `
      <p class="setup-hint">Paste your Google Maps Platform API key. It is stored only on this device.</p>
      <input type="text" inputmode="text" autocomplete="off" autocapitalize="off"
             spellcheck="false" placeholder="AIza…" aria-label="API key" />
      <button type="submit">Save &amp; continue</button>
      <a class="setup-help" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Get a key ↗</a>
    `;
    const input = form.querySelector("input");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return;
      localStorage.setItem(LS_API_KEY, val);
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
    const layers = new Layers(map);
    const hider = new Hider(map);
    await Promise.all([zones.init(), features.init()]);
    const games = new Games(zones);
    layers.init();
    hider.init();
    wireToolbar(zones, features, layers, hider);
    document.getElementById("menu-btn")?.addEventListener("click", () => games.openMenu());
    zones.fitToArea();
    window.__jltg = { zones, features, layers, hider, games, boundaries, store }; // debug / testing handle
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
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol === "file:") return; // no SW on file://
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((e) =>
      console.warn("SW registration failed:", e)
    );
  });
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
