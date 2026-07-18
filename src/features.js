// Native Google Maps features surfaced in-app (guide §7):
//  - Transit layer toggle
//  - "Directions here" on long-press (transit / walking, via Directions API)
//  - Distance between two taps (straight-line + walking time via Distance Matrix)
import { contextMenu, toast, formatDistance, openSheet, escapeHtml } from "./ui.js";
import { searchText } from "./places.js";
import * as store from "./store.js";

export class MapFeatures {
  constructor(map) {
    this.map = map;
    this.transit = null;
    this.dir = { service: null, renderer: null };
    this.matrix = null;
    this.measure = { active: false, pts: [], markers: [], line: null };
    // True while a draw/pick flow owns the map click (see init).
    this._mapClaimed = false;
  }

  async init() {
    const routes = await google.maps.importLibrary("routes");
    this.dir.service = new routes.DirectionsService();
    this.dir.renderer = new routes.DirectionsRenderer({
      suppressMarkers: false,
      polylineOptions: { strokeColor: "#38bdf8", strokeWeight: 5, strokeOpacity: 0.9 },
    });
    this.matrix = new routes.DistanceMatrixService();

    // Map click — used only by measure mode, and only while nothing else owns the map.
    //
    // A draw or pick flow (layers.js `_drawShape` / `pick`) adds its OWN map click listener,
    // and Google fires every listener on the same tap. With measure mode left on, one tap into
    // an outline both added a vertex AND dropped a measure pin: the draw preview and the
    // measure line then tracked each other across the map, and the readout described a distance
    // nobody asked for. Neither handler could see the other, so neither could say what happened.
    //
    // The flow claims the click while it runs and releases it on cleanup. Measure stays
    // *active* through the claim on purpose — the toolbar button keeps telling the truth, and
    // measuring resumes on the next tap once the flow ends.
    this.map.addListener("click", (e) => this._onClick(e.latLng));
    window.addEventListener("jltg:mapclaim", () => {
      this._mapClaimed = true;
      // Drop any half-finished measurement: its pins would otherwise sit under the outline
      // being drawn, unexplained and un-clearable without leaving the flow.
      if (this.measure.active && this.measure.pts.length) this._clearMeasure();
    });
    window.addEventListener("jltg:maprelease", () => { this._mapClaimed = false; });
    // Long-press / right-click → context menu with location actions.
    this.map.addListener("contextmenu", (e) => this._onContextMenu(e));
  }

  // ---- Transit layer ----
  // On by default (Hide & Seek hiders often stay near transit, so seekers want it
  // visible from the start) — call once at boot; toggleTransit still flips it.
  setTransit(on) {
    if (!this.transit) this.transit = new google.maps.TransitLayer();
    this.transit.setMap(on ? this.map : null);
  }
  toggleTransit() {
    if (!this.transit) this.transit = new google.maps.TransitLayer();
    const on = this.transit.getMap() == null;
    this.transit.setMap(on ? this.map : null);
    // Name the limitation when it is switched ON, not just in the tooltip. This layer is raster
    // tiles from Google's own feed inventory: it takes no options, and in Mumbai it draws the
    // Metro but not the suburban locals — the lines that actually decide the game, and the
    // whole reason the Overpass line pipeline exists. It stays the default because it is
    // instant and 🚄 Rail is a slow fetch that fails ~64% of the time, but a player must not
    // have to already know that to read the map correctly.
    toast(on ? "Transit layer on — Google's feed, missing some agencies. Use 🚄 Rail for the full network." : "Transit layer off");
    return on;
  }

  // ---- Directions here ----
  _onContextMenu(e) {
    const latLng = e.latLng;
    const dom = e.domEvent || {};
    const x = dom.clientX ?? window.innerWidth / 2;
    const y = dom.clientY ?? window.innerHeight / 2;
    contextMenu(x, y, [
      { label: "🚆 Directions here (transit)", onClick: () => this.directionsTo(latLng, google.maps.TravelMode.TRANSIT) },
      { label: "🚶 Directions here (walking)", onClick: () => this.directionsTo(latLng, google.maps.TravelMode.WALKING) },
      { label: "✖ Clear directions", onClick: () => this.clearDirections() },
    ]);
  }

  async directionsTo(destination, travelMode, originOverride) {
    const origin = originOverride || (await this._getOrigin());
    if (!origin) {
      toast("Location unavailable — allow location access to get directions.");
      return;
    }
    this.dir.renderer.setMap(this.map);
    this.dir.service.route({ origin, destination, travelMode }, (res, status) => {
      if (status === "OK") {
        this.dir.renderer.setDirections(res);
        const leg = res.routes[0].legs[0];
        toast(`${leg.distance.text} · ${leg.duration.text}`, 5000);
      } else {
        toast(`Directions failed: ${status}`);
      }
    });
  }

  clearDirections() {
    this.dir.renderer.setMap(null);
    this.dir.renderer.setDirections({ routes: [] });
  }

  // Reset the per-board scratch state (a drawn route, an in-progress measurement) so
  // nothing lingers from the previous game.
  //
  // Deliberately does NOT touch the transit layer. Transit is a map-VIEW preference, not
  // per-game state, and Phase 22 made it on-by-default. Turning it off here desynced it
  // from its toolbar button on every game switch: nothing removed the `.active` class, so
  // after opening a game from history the button read "on" while the layer was off, and one
  // tap "toggled it off" — actually turning it on.
  clearAll() {
    this.clearDirections();
    this.measure.active = false;
    this._clearMeasure();
  }

  _getOrigin() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { timeout: 8000, maximumAge: 30000 }
      );
    });
  }

  // ---- Measure (draggable two-point distance) ----
  toggleMeasure() {
    this.measure.active = !this.measure.active;
    if (!this.measure.active) this._clearMeasure();
    else toast("Measure: tap two points, then drag them to adjust.");
    return this.measure.active;
  }

  _onClick(latLng) {
    if (!this.measure.active) return;
    if (this._mapClaimed) return; // a draw / pick flow owns this tap
    if (this.measure.pts.length >= 2) this._clearMeasure();
    const idx = this.measure.pts.length;
    this.measure.pts.push(latLng.toJSON());
    const marker = new google.maps.Marker({
      position: latLng,
      map: this.map,
      label: `${idx + 1}`,
      draggable: true,
      title: "Drag to move",
    });
    const onMove = () => { this.measure.pts[idx] = marker.getPosition().toJSON(); this._recomputeMeasure(); };
    marker.addListener("drag", onMove);
    marker.addListener("dragend", onMove);
    this.measure.markers.push(marker);
    this._recomputeMeasure();
  }

  _recomputeMeasure() {
    if (this.measure.line) { this.measure.line.setMap(null); this.measure.line = null; }
    if (this.measure.pts.length < 2) return;
    const [a, b] = this.measure.pts;
    this.measure.line = new google.maps.Polyline({
      path: [a, b], geodesic: true, strokeColor: "#f2c14e", strokeWeight: 3, map: this.map,
    });
    const meters = google.maps.geometry.spherical.computeDistanceBetween(a, b);
    const units = store.getCurrent()?.settings?.units || "metric";
    const straight = formatDistance(meters, units);
    this._setReadout(`📏 Straight line: ${straight}`);
    const mode = store.getCurrent()?.settings?.distanceMode || "straight-line";
    if (mode === "straight-line") return;
    const travelMode = mode === "transit" ? google.maps.TravelMode.TRANSIT : google.maps.TravelMode.WALKING;
    this.matrix.getDistanceMatrix({ origins: [a], destinations: [b], travelMode }, (res, status) => {
      const el = res?.rows?.[0]?.elements?.[0];
      if (status === "OK" && el?.status === "OK") this._setReadout(`📏 ${straight} · ${mode}: ${el.duration.text}`);
    });
  }

  _setReadout(text) {
    let el = document.getElementById("measure-readout");
    if (!el) { el = document.createElement("div"); el.id = "measure-readout"; document.body.appendChild(el); }
    el.textContent = text;
    el.classList.add("show");
  }

  _clearMeasure() {
    this.measure.markers.forEach((m) => m.setMap(null));
    this.measure.line?.setMap(null);
    this.measure = { active: this.measure.active, pts: [], markers: [], line: null };
    document.getElementById("measure-readout")?.classList.remove("show");
  }

  // ---- Directions tab (to a point, from current location / picked / searched) ----
  // The panel is rebuilt from `state` each time so map-picks (which close sheets)
  // can reopen it without losing the user's choices.
  openDirections(layers, state) {
    state = state || { origin: null, originMode: "me", destination: null, mode: "TRANSIT" };
    const fmt = (p) => (p?.name ? p.name : p ? `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` : "Not set");
    const checked = (v) => (state.mode === v ? "checked" : "");
    const s = openSheet({
      title: "Directions",
      bodyHTML: `
        <label class="fieldlbl">From</label>
        <div class="row">
          <button id="o-me" class="btn ${state.originMode === "me" ? "btn-primary" : ""}">🧭 My location</button>
          <button id="o-tap" class="btn">📍 Tap</button>
          <button id="o-search" class="btn">🔎 Search</button>
        </div>
        <p class="muted">Origin: <strong id="d-orig">${state.originMode === "me" ? "My location" : escapeHtml(fmt(state.origin))}</strong></p>
        <label class="fieldlbl">To</label>
        <div class="row">
          <button id="d-tap" class="btn">📍 Tap</button>
          <button id="d-search" class="btn">🔎 Search</button>
        </div>
        <p class="muted">Destination: <strong id="d-dest">${escapeHtml(fmt(state.destination))}</strong></p>
        <label class="fieldlbl">Mode</label>
        <div class="seg">
          <label><input type="radio" name="d-mode" value="TRANSIT" ${checked("TRANSIT")}/> 🚆 Transit</label>
          <label><input type="radio" name="d-mode" value="WALKING" ${checked("WALKING")}/> 🚶 Walking</label>
          <label><input type="radio" name="d-mode" value="DRIVING" ${checked("DRIVING")}/> 🚗 Driving</label>
        </div>
        <div class="sheet-actions">
          <button id="d-clear" class="btn btn-ghost">Clear route</button>
          <button id="d-go" class="btn btn-primary">Get directions</button>
        </div>
        <p id="d-status" class="muted"></p>`,
    });
    s.qa('input[name="d-mode"]').forEach((r) => (r.onchange = () => (state.mode = r.value)));
    s.q("#o-me").onclick = () => { state.originMode = "me"; state.origin = null; s.q("#d-orig").textContent = "My location"; s.q("#o-me").classList.add("btn-primary"); };
    s.q("#o-tap").onclick = async () => { s.close(); const p = await layers.pick(1, "Tap the origin."); if (p) { state.origin = p[0]; state.originMode = "point"; } this.openDirections(layers, state); };
    s.q("#o-search").onclick = async () => { const p = await this._placeSearch("Search origin…"); if (p) { state.origin = p; state.originMode = "point"; } this.openDirections(layers, state); };
    s.q("#d-tap").onclick = async () => { s.close(); const p = await layers.pick(1, "Tap the destination."); if (p) state.destination = p[0]; this.openDirections(layers, state); };
    s.q("#d-search").onclick = async () => { const p = await this._placeSearch("Search destination…"); if (p) state.destination = p; this.openDirections(layers, state); };
    s.q("#d-clear").onclick = () => { this.clearDirections(); s.q("#d-status").textContent = "Route cleared."; };
    s.q("#d-go").onclick = async () => {
      if (!state.destination) { s.q("#d-status").textContent = "Set a destination first."; return; }
      s.q("#d-status").textContent = "Routing…";
      const origin = state.originMode === "me" ? await this._getOrigin() : state.origin;
      if (!origin) { s.q("#d-status").textContent = "Origin unavailable — allow location or pick one."; return; }
      s.close();
      this.directionsTo(state.destination, google.maps.TravelMode[state.mode] || google.maps.TravelMode.TRANSIT, origin);
    };
  }

  _placeSearch(prompt) {
    return new Promise((resolve) => {
      let done = false;
      const s = openSheet({
        title: "Search place",
        bodyHTML: `
          <input id="ps-q" class="field" placeholder="${escapeHtml(prompt)}" />
          <div class="sheet-actions">
            <button id="ps-cancel" class="btn btn-ghost">Cancel</button>
            <button id="ps-go" class="btn btn-primary">Search</button>
          </div>
          <ul id="ps-res" class="list"></ul>`,
        onClose: () => { if (!done) resolve(null); },
      });
      s.q("#ps-q").focus();
      const run = async () => {
        const q = s.q("#ps-q").value.trim();
        if (!q) return;
        s.q("#ps-res").innerHTML = '<li class="muted">Searching…</li>';
        try {
          const r = await searchText(this.map, q);
          if (!r.length) { s.q("#ps-res").innerHTML = '<li class="muted">No results.</li>'; return; }
          // No cap — the list scrolls. This used to slice to 8, which (on top of
          // searchText not paginating at all) put the place the seeker wanted out of reach
          // with no sign it existed.
          s.q("#ps-res").innerHTML = r
            .map((x, i) => `<li><button class="btn btn-ghost btn-sm" data-i="${i}" style="text-align:left">${escapeHtml(x.name)}<br><span class="muted">${escapeHtml(x.address)}</span></button></li>`)
            .join("");
          s.qa("[data-i]").forEach((b) => (b.onclick = () => { done = true; s.close(); resolve(r[parseInt(b.dataset.i, 10)]); }));
        } catch (e) {
          s.q("#ps-res").innerHTML = `<li class="muted">${escapeHtml(e.message)}</li>`;
        }
      };
      s.q("#ps-go").onclick = run;
      s.q("#ps-q").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
      s.q("#ps-cancel").onclick = () => s.close();
    });
  }
}
