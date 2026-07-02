// App bootstrap: wire config -> DB/store -> Google Map -> PWA install.
import { loadGoogleMaps, createMap } from "./maps.js";
import * as store from "./store.js";

const boot = document.getElementById("boot");
const bootMsg = document.getElementById("boot-msg");
const bootDetail = document.getElementById("boot-detail");
const gameNameEl = document.getElementById("game-name");

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

async function main() {
  const cfg = window.JLTG_CONFIG;
  if (!cfg) {
    setBoot("Configuration missing", "Copy config.example.js to config.js and add your API key.", true);
    return;
  }

  // 1) Local storage / current game.
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

  // 2) Google Maps.
  setBoot("Loading map…");
  try {
    await loadGoogleMaps(cfg.GOOGLE_MAPS_API_KEY);
    const map = await createMap(document.getElementById("map"), {
      center: cfg.DEFAULT_CENTER,
      zoom: cfg.DEFAULT_ZOOM,
    });
    window.__jltgMap = map; // handy for debugging / later phases
    hideBoot();
  } catch (e) {
    console.error(e);
    setBoot("Map failed to load", String(e.message || e), true);
    return;
  }
}

function reflectGame(game) {
  if (gameNameEl && game) gameNameEl.textContent = game.name || "";
}

// --- PWA: service worker + install prompt ---------------------------------
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // Only register when served over http(s); file:// has no SW.
  if (location.protocol === "file:") return;
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
