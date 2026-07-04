// Hiding zone: set a centre point and a "hider radius"; everything OUTSIDE the
// radius is shaded out. The radius is per game (it changes each game). Persists as
// hiderLock = { locked, point:{lat,lng}, stationName, radius } — here `locked`
// simply means a zone centre has been placed.
import * as store from "./store.js";
import { geojsonToPathGroups } from "./geo.js";
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
    store.saveNow(); // persist immediately (a quick app-close shouldn't lose it)
    // Shading needs a radius; nudge the user if one isn't set yet.
    toast(store.getCurrent()?.hiderLock?.radius ? "Hider centre set." : "Hider centre set — add a radius to shade the zone.");
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
    toast("Hiding zone cleared.");
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

    // Hiding-zone mask: shade EVERYTHING outside the radius, so the hiding zone
    // reads as the one clear spot on the map.
    if (lock.radius && lock.radius > 0 && window.turf) {
      const turf = window.turf;
      const p = lock.point;
      const circle = turf.circle([p.lng, p.lat], lock.radius / 1000, { units: "kilometers", steps: 72 });
      // Subtract the circle from a large-but-LOCAL rectangle around it — not the
      // game area (a blank board would then shade only a tiny box, leaving most of
      // the view bright) and not a near-global rect (Google Maps mis-fills those
      // and darkens the hole instead). Scale the pad with the radius but keep it
      // local; the circle stays a true hole. Mirrors layers.js maskOutside. Where a
      // game area exists, the play-area mask (layers.js) already darkens anything
      // outside it, so the net clear region is still the zone ∩ play area.
      const rKm = lock.radius / 1000;
      const pad = Math.min(40, Math.max(8, (rKm / 111) * 6)); // ≥ ~880 km, never near-global
      const minX = Math.max(-179.9, p.lng - pad), maxX = Math.min(179.9, p.lng + pad);
      const minY = Math.max(-85, p.lat - pad), maxY = Math.min(85, p.lat + pad);
      const rect = turf.polygon([[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]);
      let mask = null;
      try {
        const diff = turf.difference(turf.featureCollection([rect, circle]));
        mask = diff ? diff.geometry : null;
      } catch (e) { console.warn("hider mask failed", e); }
      if (mask) {
        // Use path GROUPS so the inside of the radius is a true hole (clear),
        // not a separately-filled shape that double-shades the hiding zone.
        for (const group of geojsonToPathGroups(mask)) {
          this.overlays.push(new google.maps.Polygon({ ...MASK_STYLE, paths: group, map: this.map }));
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
      title: "Hiding zone",
      bodyHTML: `
        <p class="muted">Set the hider's zone centre and radius. Everything outside the radius is shaded out.</p>
        <p>Centre: <strong>${locked && pt ? `${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}` : "Not set"}</strong></p>
        <div class="row">
          <button id="h-tap" class="btn btn-primary">📍 Set centre by tapping</button>
          <button id="h-loc" class="btn">🧭 My location</button>
        </div>
        <label class="fieldlbl">Hider radius (metres) — shades everything outside this zone</label>
        <input id="h-radius" class="field" type="number" inputmode="numeric" placeholder="e.g. 500" value="${lock.radius || ""}" min="0" step="10" />
        <div class="row">
          <button id="h-apply" class="btn btn-primary">Apply radius</button>
          <button id="h-nozone" class="btn">No zone</button>
        </div>
        <div class="row">
          <button id="h-clear" class="btn btn-ghost" ${locked ? "" : "disabled"}>Clear zone</button>
        </div>`,
    });
    s.q("#h-tap").onclick = async () => {
      s.close();
      const pts = await layers.pick(1, "Tap the hiding-zone centre on the map.");
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
      if (!locked) return toast("Set the zone centre first.");
      const r = Math.max(0, parseFloat(s.q("#h-radius").value) || 0);
      this.setRadius(r);
      s.close();
      toast(r > 0 ? "Hiding zone applied." : "No hiding zone.");
    };
    s.q("#h-nozone").onclick = () => { this.setRadius(null); s.close(); toast("Hiding zone removed."); };
    s.q("#h-clear").onclick = () => { this.clear(); s.close(); };
  }
}
