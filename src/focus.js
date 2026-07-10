// Hider zone (solo aid): when the seeker knows/suspects roughly where the hider
// is, drop a centre point and a radius — everything OUTSIDE the radius is shaded
// out, so the suspected area reads as the one clear spot. Purely local, per game;
// stored as focusZone = { point:{lat,lng}, radius } (radius in metres, may be null
// for just a marker). No multiplayer, no reveal logic — it never touches the
// question/elimination engine.
import * as store from "./store.js";
import { geojsonToPathGroups } from "./geo.js";
import { openSheet, toast } from "./ui.js";

const MASK_STYLE = { strokeOpacity: 0, fillColor: "#020a0c", fillOpacity: 0.5, clickable: false };
const ZONE_STYLE = { strokeColor: "#a78bfa", strokeOpacity: 0.95, strokeWeight: 2, fillOpacity: 0, clickable: false };

export class Focus {
  constructor(map) {
    this.map = map;
    this.overlays = [];
  }

  init() {
    store.subscribe(() => this.render());
    this.render();
  }

  _zone() {
    return store.getCurrent()?.focusZone || null;
  }
  point() {
    return this._zone()?.point || null;
  }

  setPoint(point) {
    store.update((g) => {
      const radius = g.focusZone?.radius || null; // keep any existing radius
      g.focusZone = { point, radius };
    });
    store.saveNow(); // persist immediately (a quick app-close shouldn't lose it)
    toast(this._zone()?.radius ? "Hider centre set." : "Hider centre set — add a radius to shade the zone.");
  }
  setRadius(radius) {
    store.update((g) => {
      if (!g.focusZone) g.focusZone = { point: null, radius: null };
      g.focusZone.radius = radius && radius > 0 ? radius : null;
    });
    store.saveNow();
  }
  clear() {
    store.update((g) => (g.focusZone = { point: null, radius: null }));
    store.saveNow();
    toast("Hider zone cleared.");
  }

  render() {
    this._clear();
    const zone = this._zone();
    if (!zone?.point) return;

    // The hider pin.
    this.overlays.push(new google.maps.Marker({
      position: zone.point,
      map: this.map,
      title: "Hider",
      label: { text: "H", color: "#04252a", fontWeight: "700" },
      zIndex: 9999,
    }));

    // Zone mask: shade EVERYTHING outside the radius, so the target area reads as
    // the one clear spot on the map.
    if (zone.radius && zone.radius > 0 && window.turf) {
      const turf = window.turf;
      const p = zone.point;
      const circle = turf.circle([p.lng, p.lat], zone.radius / 1000, { units: "kilometers", steps: 72 });
      // Subtract the circle from a large-but-LOCAL rectangle around it — not the
      // game area (a blank board would then shade only a tiny box) and not a
      // near-global rect (Google Maps mis-fills those and darkens the hole
      // instead). Scale the pad with the radius but keep it local; the circle
      // stays a true hole. Where a game area exists, layers.js already darkens
      // outside it, so the net clear region is the target ∩ play area.
      const rKm = zone.radius / 1000;
      const pad = Math.min(40, Math.max(8, (rKm / 111) * 6)); // ≥ ~880 km, never near-global
      const minX = Math.max(-179.9, p.lng - pad), maxX = Math.min(179.9, p.lng + pad);
      const minY = Math.max(-85, p.lat - pad), maxY = Math.min(85, p.lat + pad);
      const rect = turf.polygon([[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]);
      let mask = null;
      try {
        const diff = turf.difference(turf.featureCollection([rect, circle]));
        mask = diff ? diff.geometry : null;
      } catch (e) { console.warn("focus mask failed", e); }
      if (mask) {
        // Path GROUPS so the inside of the radius is a true hole (clear), not a
        // separately-filled shape that double-shades the zone.
        for (const group of geojsonToPathGroups(mask)) {
          this.overlays.push(new google.maps.Polygon({ ...MASK_STYLE, paths: group, map: this.map }));
        }
      }
      // The zone boundary circle.
      this.overlays.push(new google.maps.Circle({ ...ZONE_STYLE, center: zone.point, radius: zone.radius, map: this.map }));
    }
  }

  _clear() {
    this.overlays.forEach((o) => o.setMap(null));
    this.overlays = [];
  }

  openPanel(layers) {
    const zone = this._zone() || {};
    const pt = zone.point;
    const s = openSheet({
      title: "Hider zone",
      bodyHTML: `
        <p class="muted">If you know roughly where the hider is, set a centre and radius — everything outside the radius is shaded out.</p>
        <p>Centre: <strong>${pt ? `${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}` : "Not set"}</strong></p>
        <div class="row">
          <button id="f-tap" class="btn btn-primary">📍 Set centre by tapping</button>
          <button id="f-loc" class="btn">🧭 My location</button>
        </div>
        <label class="fieldlbl">Radius (metres) — shades everything outside this zone</label>
        <input id="f-radius" class="field" type="number" inputmode="numeric" placeholder="e.g. 500" value="${zone.radius || ""}" min="0" step="10" />
        <div class="row">
          <button id="f-apply" class="btn btn-primary">Apply radius</button>
          <button id="f-noradius" class="btn">Marker only</button>
        </div>
        <div class="row">
          <button id="f-clear" class="btn btn-ghost" ${pt ? "" : "disabled"}>Clear zone</button>
        </div>`,
    });
    s.q("#f-tap").onclick = async () => {
      s.close();
      const pts = await layers.pick(1, "Tap the hider-zone centre on the map.");
      if (pts) this.setPoint(pts[0]);
    };
    s.q("#f-loc").onclick = () => {
      if (!navigator.geolocation) return toast("Geolocation not available.");
      navigator.geolocation.getCurrentPosition(
        (p) => { this.setPoint({ lat: p.coords.latitude, lng: p.coords.longitude }); s.close(); },
        () => toast("Location unavailable — allow location access."),
        { timeout: 8000 }
      );
    };
    s.q("#f-apply").onclick = () => {
      if (!pt) return toast("Set the zone centre first.");
      const r = Math.max(0, parseFloat(s.q("#f-radius").value) || 0);
      this.setRadius(r);
      s.close();
      toast(r > 0 ? "Hider zone applied." : "Marker only — no shading.");
    };
    s.q("#f-noradius").onclick = () => { this.setRadius(null); s.close(); toast("Radius removed."); };
    s.q("#f-clear").onclick = () => { this.clear(); s.close(); };
  }
}
