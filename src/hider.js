// Hider lock (guide §6.1): pin the hider's true location so the elimination tools
// can auto-answer their own questions. Persists with the game as
// hiderLock = { locked, point:{lat,lng}, stationName, radius }.
//
// Optionally shades everything OUTSIDE a "hider radius" (the hiding zone) around
// the lock — set per game, since the allowed hiding radius changes each game.
import * as store from "./store.js";
import { geojsonToPaths } from "./geo.js";
import { openSheet, toast } from "./ui.js";

const MASK_STYLE = { strokeOpacity: 0, fillColor: "#020a0c", fillOpacity: 0.5, clickable: false };
const ZONE_STYLE = { strokeColor: "#a78bfa", strokeOpacity: 0.95, strokeWeight: 2, fillOpacity: 0, clickable: false };

export class Hider {
  constructor(map) {
    this.map = map;
    this.overlays = [];
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
    store.update((g) => {
      const radius = g.hiderLock?.radius || null; // keep any existing radius
      g.hiderLock = { locked: true, point, stationName, radius };
    });
    store.saveNow(); // persist immediately (a quick app-close shouldn't lose the lock)
    toast("Hider lock set — tools can now auto-answer.");
  }
  setRadius(radius) {
    store.update((g) => {
      if (!g.hiderLock) g.hiderLock = { locked: false, point: null, stationName: null };
      g.hiderLock.radius = radius && radius > 0 ? radius : null;
    });
    store.saveNow();
  }
  clear() {
    store.update((g) => (g.hiderLock = { locked: false, point: null, stationName: null, radius: null }));
    store.saveNow();
    toast("Hider lock cleared.");
  }

  render() {
    this._clear();
    const g = store.getCurrent();
    const lock = g?.hiderLock;
    if (!(lock?.locked && lock.point)) return;

    // The "H" pin.
    this.overlays.push(new google.maps.Marker({
      position: lock.point,
      map: this.map,
      title: lock.stationName || "Hider lock",
      label: { text: "H", color: "#04252a", fontWeight: "700" },
      zIndex: 9999,
    }));

    // Hiding-zone mask: shade everything outside the radius.
    if (lock.radius && lock.radius > 0 && window.turf) {
      const turf = window.turf;
      const circle = turf.circle([lock.point.lng, lock.point.lat], lock.radius / 1000, { units: "kilometers", steps: 72 });
      // Base to subtract from: the game area if defined, else a large box.
      let base;
      if (g.gameArea) {
        base = turf.feature(g.gameArea);
      } else {
        const d = 0.6, p = lock.point;
        base = turf.polygon([[[p.lng - d, p.lat - d], [p.lng + d, p.lat - d], [p.lng + d, p.lat + d], [p.lng - d, p.lat + d], [p.lng - d, p.lat - d]]]);
      }
      let mask = null;
      try {
        const diff = turf.difference(turf.featureCollection([base, circle]));
        mask = diff ? diff.geometry : null;
      } catch (e) { console.warn("hider mask failed", e); }
      if (mask) {
        for (const path of geojsonToPaths(mask)) {
          this.overlays.push(new google.maps.Polygon({ ...MASK_STYLE, paths: path, map: this.map }));
        }
      }
      // The hiding-zone boundary circle.
      this.overlays.push(new google.maps.Circle({ ...ZONE_STYLE, center: lock.point, radius: lock.radius, map: this.map }));
    }
  }

  _clear() {
    this.overlays.forEach((o) => o.setMap(null));
    this.overlays = [];
  }

  openPanel(layers) {
    const g = store.getCurrent();
    const lock = g?.hiderLock || {};
    const locked = this.isLocked();
    const pt = lock.point;
    const s = openSheet({
      title: "Hider lock",
      bodyHTML: `
        <p class="muted">Lock the hider's true location so each tool can auto-answer its own question (great for the hider's phone, or for testing).</p>
        <p>Status: <strong>${locked ? "Locked" : "Not set"}</strong>${locked && pt ? ` · ${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}` : ""}</p>
        <div class="row">
          <button id="h-tap" class="btn btn-primary">📍 Set by tapping</button>
          <button id="h-loc" class="btn">🧭 My location</button>
        </div>
        <label class="fieldlbl">Hider radius (metres) — shades everything outside this zone</label>
        <input id="h-radius" class="field" type="number" inputmode="numeric" placeholder="e.g. 500" value="${lock.radius || ""}" min="0" step="10" />
        <div class="row">
          <button id="h-apply" class="btn btn-primary">Apply radius</button>
          <button id="h-nozone" class="btn">No zone</button>
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
    s.q("#h-apply").onclick = () => {
      if (!locked) return toast("Set the hider lock first.");
      const r = Math.max(0, parseFloat(s.q("#h-radius").value) || 0);
      this.setRadius(r);
      s.close();
      toast(r > 0 ? "Hiding zone applied." : "No hiding zone.");
    };
    s.q("#h-nozone").onclick = () => { this.setRadius(null); s.close(); toast("Hiding zone removed."); };
    s.q("#h-clear").onclick = () => { this.clear(); s.close(); };
  }
}
