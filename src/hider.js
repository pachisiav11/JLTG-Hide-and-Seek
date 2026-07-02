// Hider lock (guide §6.1): pin the hider's true location so the elimination tools
// can auto-answer their own questions. Persists with the game as
// hiderLock = { locked, point:{lat,lng}, stationName }.
import * as store from "./store.js";
import { openSheet, toast } from "./ui.js";

export class Hider {
  constructor(map) {
    this.map = map;
    this.marker = null;
  }

  init() {
    store.subscribe(() => this.render());
    this.render();
  }

  isLocked() {
    return !!store.getCurrent()?.hiderLock?.locked;
  }
  point() {
    return store.getCurrent()?.hiderLock?.point || null;
  }

  setLock(point, stationName = null) {
    store.update((g) => (g.hiderLock = { locked: true, point, stationName }));
    toast("Hider lock set — tools can now auto-answer.");
  }
  clear() {
    store.update((g) => (g.hiderLock = { locked: false, point: null, stationName: null }));
    toast("Hider lock cleared.");
  }

  render() {
    if (this.marker) { this.marker.setMap(null); this.marker = null; }
    const lock = store.getCurrent()?.hiderLock;
    if (lock?.locked && lock.point) {
      this.marker = new google.maps.Marker({
        position: lock.point,
        map: this.map,
        title: lock.stationName || "Hider lock",
        label: { text: "H", color: "#04252a", fontWeight: "700" },
        zIndex: 9999,
      });
    }
  }

  openPanel(layers) {
    const g = store.getCurrent();
    const locked = this.isLocked();
    const pt = g?.hiderLock?.point;
    const s = openSheet({
      title: "Hider lock",
      bodyHTML: `
        <p class="muted">Lock the hider's true location so each tool can auto-answer its own question (great for the hider's phone, or for testing).</p>
        <p>Status: <strong>${locked ? "Locked" : "Not set"}</strong>${locked && pt ? ` · ${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}` : ""}</p>
        <div class="row">
          <button id="h-tap" class="btn btn-primary">📍 Set by tapping</button>
          <button id="h-loc" class="btn">🧭 My location</button>
        </div>
        <div class="row">
          <button id="h-clear" class="btn btn-ghost" ${locked ? "" : "disabled"}>Clear lock</button>
        </div>`,
    });
    s.q("#h-tap").onclick = async () => {
      s.close();
      const pts = await layers.pick(1, "Tap the hider's location on the map.");
      if (pts) this.setLock(pts[0]);
    };
    s.q("#h-loc").onclick = () => {
      if (!navigator.geolocation) return toast("Geolocation not available.");
      navigator.geolocation.getCurrentPosition(
        (p) => { this.setLock({ lat: p.coords.latitude, lng: p.coords.longitude }); s.close(); },
        () => toast("Location unavailable — allow location access."),
        { timeout: 8000 }
      );
    };
    s.q("#h-clear").onclick = () => { this.clear(); s.close(); };
  }
}
