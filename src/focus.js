// Hider zone (solo aid): when the seeker knows/suspects roughly where the hider
// is, drop a centre point and a radius — everything OUTSIDE the radius is shaded
// out, so the suspected area reads as the one clear spot. Purely local, per game;
// stored as focusZone = { point:{lat,lng}, radius } (radius in metres, may be null
// for just a marker). No multiplayer, no reveal logic — it never touches the
// question/elimination engine.
import * as store from "./store.js";
import { geojsonToPathGroups } from "./geo.js";
import { openSheet, toast, distanceFieldHTML, readDistanceMeters } from "./ui.js";

const MASK_STYLE = { strokeOpacity: 0, fillColor: "#020a0c", fillOpacity: 0.5, clickable: false };
const ZONE_STYLE = { strokeColor: "#a78bfa", strokeOpacity: 0.95, strokeWeight: 2, fillOpacity: 0, clickable: false };

export class Focus {
  constructor(map) {
    this.map = map;
    this.overlays = [];
  }

  init() {
    // subscribe() renders synchronously when a current game exists (app.js awaits
    // store.init() first), so an explicit this.render() here just rebuilt the overlay a
    // second time at boot. See layers.js init().
    store.subscribe(() => this.render());
  }

  _zone() {
    return store.getCurrent()?.focusZone || null;
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

  // Phase 34 (req #8): the edge-alert threshold, surfaced right in the Hider-zone
  // flow instead of buried in Settings — this is where a hider sets up the zone
  // they'll be sitting in, so it's where they'll want the "warn me near the
  // edge" control. Writing settings.geofenceMetres is all it takes: the Geofence
  // watcher subscribes to the store and (re)starts its GPS watch on the change
  // once a zone with a radius also exists. 0 (or junk) disables it. Pure enough
  // to unit-test the write + the watch-start it triggers.
  setGeofenceThreshold(metres) {
    const m = Number(metres);
    // store.update already schedules the (debounced) autosave and emits the
    // change synchronously, so the Geofence watcher reconciles immediately — no
    // explicit saveNow() needed (and none of its no-IndexedDB reject noise).
    store.update((g) => {
      g.settings = { ...g.settings, geofenceMetres: Number.isFinite(m) && m > 0 ? m : 0 };
    });
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
    const units = store.getCurrent()?.settings?.units || "metric";
    const gm = Number(store.getCurrent()?.settings?.geofenceMetres) || 0;
    const gfRadio = (value, label) =>
      `<label><input type="radio" name="f-geofence" value="${value}" ${gm === Number(value) ? "checked" : ""}/> ${label}</label>`;
    const s = openSheet({
      title: "Hider zone",
      bodyHTML: `
        <p class="muted">If you know roughly where the hider is, set a centre and radius — everything outside the radius is shaded out.</p>
        <p>Centre: <strong>${pt ? `${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}` : "Not set"}</strong></p>
        <div class="row">
          <button id="f-tap" class="btn btn-primary">📍 Set centre by tapping</button>
          <button id="f-loc" class="btn">🧭 My location</button>
        </div>
        <label class="fieldlbl">Radius — shades everything outside this zone</label>
        ${distanceFieldHTML("f-radius", zone.radius ?? NaN, units, { placeholder: "e.g. 500" })}
        <div class="row">
          <button id="f-apply" class="btn btn-primary">Apply radius</button>
          <button id="f-noradius" class="btn">Marker only</button>
        </div>
        <label class="fieldlbl">Edge alert — warn me when I'm this close to the edge (or if I cross it)</label>
        <div class="seg">
          ${gfRadio("0", "Off")}
          ${gfRadio("50", "50 m")}
          ${gfRadio("100", "100 m")}
          ${gfRadio("200", "200 m")}
        </div>
        <p class="warn-note">⚠️ Alerts only fire while the app is open. Install the Android app for background alerts.</p>
        <div class="row">
          <button id="f-clear" class="btn btn-ghost" ${pt ? "" : "disabled"}>Clear zone</button>
        </div>`,
    });
    // Apply the edge-alert threshold live on selection (the Geofence watcher
    // reconciles off the store change) — no separate save step in this flow.
    s.qa('input[name="f-geofence"]').forEach((r) => (r.onchange = () => {
      this.setGeofenceThreshold(r.value);
      toast(Number(r.value) > 0 ? `Edge alert at ${r.value} m.` : "Edge alert off.");
    }));
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
      // Validate rather than swallow: `|| 0` turned "abc" into 0, which setRadius reads as
      // "marker only" — silently discarding the zone the seeker meant to set. Unlike the
      // question sheets, 0 IS meaningful here (it means marker only), so only a
      // non-numeric entry is rejected. Stored in metres, whatever unit was typed.
      const raw = s.q("#f-radius")?.value.trim();
      const r = raw === "" ? 0 : readDistanceMeters(s, "f-radius", units);
      if (!Number.isFinite(r) || r < 0) return toast("Enter a radius as a number, or use Marker only.");
      this.setRadius(r);
      s.close();
      toast(r > 0 ? "Hider zone applied." : "Marker only — no shading.");
    };
    s.q("#f-noradius").onclick = () => { this.setRadius(null); s.close(); toast("Radius removed."); };
    s.q("#f-clear").onclick = () => { this.clear(); s.close(); };
  }
}
