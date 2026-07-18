// Zone management: draw / import zones, maintain a reusable zone library, and
// assemble the game area (turf.union of all zones). Renders zones + the game-area
// boundary on the map and keeps everything persisted through the store.
import * as store from "./store.js";
import * as db from "./db.js";
import { createZone } from "./model.js";
import { geojsonToPaths, unionRings, parseZoneInput, areaSummary, ringSelfIntersections, ringCrossesAntimeridian } from "./geo.js";
import { openSheet, toast, escapeHtml } from "./ui.js";
import { getPalette } from "./palette.js";

// Non-colour style props; hues come from the active palette (Phase 7 colour-blind
// toggle) so a theme switch restyles zones live. The drawing preview keeps the
// default teal (getPalette().zone) too.
const ZONE_STYLE = { strokeOpacity: 0.95, strokeWeight: 1.5, fillOpacity: 0.12 };
const AREA_STYLE = { strokeOpacity: 0.95, strokeWeight: 3, fillOpacity: 0 };
const zoneStyle = () => { const p = getPalette(); return { ...ZONE_STYLE, strokeColor: p.zone, fillColor: p.zone }; };
const areaStyle = () => ({ ...AREA_STYLE, strokeColor: getPalette().area });

export class Zones {
  constructor(map, boundaries = null) {
    this.map = map;
    this.boundaries = boundaries; // official-boundary reference overlays
    this.zonePolys = [];
    this.areaPolys = [];
    this._draw = null; // active drawing session
  }

  async init() {
    // Polygon/Polyline are in the core 'maps' library (already loaded). We draw
    // zones with a custom click-to-add tool (the old DrawingManager was removed
    // from the Maps JS API in v3.65).
    // subscribe() renders synchronously when a current game exists (app.js awaits
    // store.init() first), so an explicit this.render() here just rebuilt every overlay a
    // second time at boot. See layers.js init().
    store.subscribe(() => this.render());
    window.addEventListener("jltg:palette", () => this.render());
  }

  // ---- Custom polygon drawing ----
  startDraw() {
    if (this._draw) return;
    this._draw = { pts: [], preview: null, bar: null, listener: null };
    // Own the map click while drawing — measure mode listens on the same event, and both
    // handlers fire on one tap (see layers.js _claimMapClicks / features.js init).
    window.dispatchEvent(new CustomEvent("jltg:mapclaim"));
    this.map.setOptions({ draggableCursor: "crosshair" });
    this._draw.listener = this.map.addListener("click", (e) => this._addVertex(e.latLng));
    this._draw.bar = this._makeDrawBar();
    toast("Tap the map to add points, then Finish.");
  }

  _addVertex(latLng) {
    if (!this._draw) return;
    this._draw.pts.push(latLng);
    this._updatePreview();
  }

  _updatePreview() {
    const d = this._draw;
    if (d.preview) d.preview.setMap(null);
    const path = d.pts.slice();
    if (path.length >= 3) {
      d.preview = new google.maps.Polygon({ ...zoneStyle(), paths: path, clickable: false, map: this.map });
    } else if (path.length >= 1) {
      d.preview = new google.maps.Polyline({ path, strokeColor: getPalette().zone, strokeWeight: 2, map: this.map });
    } else {
      d.preview = null;
    }
    const cnt = d.bar?.querySelector(".draw-count");
    if (cnt) cnt.textContent = `${path.length} point${path.length === 1 ? "" : "s"}`;
  }

  _makeDrawBar() {
    const bar = document.createElement("div");
    bar.className = "draw-bar";
    bar.innerHTML = `
      <span class="draw-count">0 points</span>
      <button data-d="undo" class="btn btn-ghost btn-sm">Undo</button>
      <button data-d="cancel" class="btn btn-ghost btn-sm">Cancel</button>
      <button data-d="finish" class="btn btn-primary btn-sm">Finish</button>`;
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.d === "undo") { this._draw.pts.pop(); this._updatePreview(); }
      else if (b.dataset.d === "cancel") this._endDraw();
      else if (b.dataset.d === "finish") this._finishDraw();
    });
    document.body.appendChild(bar);
    return bar;
  }

  async _finishDraw() {
    if (!this._draw) return;
    const pts = this._draw.pts.slice();
    if (pts.length < 3) { toast("Add at least 3 points to make a zone."); return; }
    const ring = pts.map((ll) => [ll.lat(), ll.lng()]);
    // A self-crossing zone is the worst version of D1: unionRings still returns a valid
    // Polygon, but its AREA is 0 (the lobes wind opposite ways and cancel), so the board
    // silently has no area — every question then eliminates nothing and no POI is ever
    // "in the area". Nothing throws, so this must be refused at the point of drawing, while
    // the points are still on screen and fixable. Kept before _endDraw so Undo still works.
    if (ringSelfIntersections(ring)) {
      toast("This zone crosses itself, so it has no clear inside — undo the last point or two and close it without crossing.");
      return;
    }
    // D2: a board across the ±180° line silently unions to ~1800x its intended size.
    if (ringCrossesAntimeridian(ring)) {
      toast("A zone can't cross the ±180° line yet — draw it on one side of the date line.");
      return;
    }
    this._endDraw();
    const name = await promptZoneName("");
    if (name === null) return; // cancelled
    await this.addZone(name || `Zone ${store.getCurrent().zones.length + 1}`, ring, { toLibrary: true });
  }

  _endDraw() {
    const d = this._draw;
    if (!d) return;
    window.dispatchEvent(new CustomEvent("jltg:maprelease"));
    if (d.listener) google.maps.event.removeListener(d.listener);
    if (d.preview) d.preview.setMap(null);
    d.bar?.remove();
    this.map.setOptions({ draggableCursor: null });
    this._draw = null;
  }

  // ---- Add / remove ----

  // Fold a zone list into the play area, refusing to let a FAILED union read as "no zones".
  //
  // unionRings returns null for both — "there is nothing to union" and "turf could not union
  // these" — and assigning that straight to g.gameArea deleted the board. Everything
  // downstream is guarded on `g.gameArea` being truthy (layers.js:256 skips every guide;
  // computeActiveArea returns null), so the map goes blank, every question stops computing,
  // and nothing says why. addZone even toasted `Added "X"` on the way out, because
  // areaSummary(null) is null and the message falls back to the no-size wording.
  //
  // An empty zone list is the one case where a null area is the truth.
  static _fold(zones) {
    const rings = (zones || []).map((z) => z.polygon);
    if (!rings.length) return { ok: true, area: null };
    const area = unionRings(rings);
    return area ? { ok: true, area } : { ok: false, area: null };
  }

  async addZone(name, ring, { toLibrary = false } = {}) {
    const zone = createZone({ name, polygon: ring });
    // Refuse the ZONE rather than lose the BOARD. A zone that cannot be folded in is one
    // shape; the alternative was discarding an assembled play area and every question
    // standing on it, for the same bad input.
    let merged = true;
    store.update((g) => {
      g.zones.push(zone);
      const { ok, area } = Zones._fold(g.zones);
      if (ok) { g.gameArea = area; return; }
      // Put the board back exactly as it was, and say so — a refused zone leaves the record
      // byte-identical, so writing and re-rendering it would be pure waste.
      g.zones.pop();
      merged = false;
      return false;
    });
    if (!merged) {
      toast(`Couldn’t merge “${zone.name}” into the play area, so it wasn’t added. The existing zones are unchanged.`);
      return null;
    }
    if (toLibrary) await this.saveToLibrary(zone);
    this.fitToArea();
    // Surface a size sanity-check for the assembled area (Phase 7).
    const g = store.getCurrent();
    const sum = areaSummary(g?.gameArea, g?.settings?.units);
    toast(sum ? `Added “${zone.name}” · game area ${sum.text}` : `Added “${zone.name}”.`);
    return zone;
  }

  // Removing the LAST zone legitimately empties the board — that is `_fold`'s ok/null case,
  // and it still clears gameArea. What is refused is a union that fails on the zones that
  // REMAIN: taking one zone away must not blank a board the other zones still describe.
  removeZone(id) {
    let rebuilt = true;
    store.update((g) => {
      const kept = g.zones.filter((z) => z.id !== id);
      const { ok, area } = Zones._fold(kept);
      if (!ok) { rebuilt = false; return false; } // nothing was touched — see store.update
      g.zones = kept;
      g.gameArea = area;
    });
    if (!rebuilt) toast("Couldn’t rebuild the play area without that zone, so it was kept. Try removing a different one.");
  }

  // ---- Import (paste GeoJSON or coordinates) ----
  async importText(text) {
    const parsed = parseZoneInput(text);
    if (!parsed.length) {
      toast("Couldn’t parse any polygon from that input.");
      return 0;
    }
    // Pasted geometry gets the same D1 check as drawn geometry — a self-crossing ring from a
    // file zeroes the board's area exactly as a badly-tapped one does. Skip only the bad
    // rings and say which: refusing the whole paste over one bad polygon would throw away
    // the good ones, and importing it silently would be the failure this guard is for.
    let skipped = 0, crossing = 0, added = 0, unmerged = 0;
    for (const { name, ring } of parsed) {
      if (ringSelfIntersections(ring)) { skipped++; continue; }
      if (ringCrossesAntimeridian(ring)) { crossing++; continue; }
      // addZone now returns null when the union refused the zone — count it as skipped
      // rather than added, or the paste reports a zone the board does not have.
      if (await this.addZone(name || `Imported zone`, ring, { toLibrary: true })) added++;
      else unmerged++;
    }
    if (skipped) toast(`Skipped ${skipped} self-crossing polygon${skipped === 1 ? "" : "s"} — ${skipped === 1 ? "it has" : "they have"} no clear inside.`);
    if (crossing) toast(`Skipped ${crossing} polygon${crossing === 1 ? "" : "s"} crossing the ±180° line — not supported yet.`);
    if (unmerged) toast(`Skipped ${unmerged} polygon${unmerged === 1 ? "" : "s"} that couldn’t be merged into the play area.`);
    return added;
  }

  // ---- Zone library (IndexedDB 'zones' store) ----
  listLibrary() {
    return db.getAll("zones");
  }
  saveToLibrary(zone) {
    return db.put("zones", { id: zone.id, name: zone.name, polygon: zone.polygon });
  }
  deleteFromLibrary(id) {
    return db.del("zones", id);
  }
  async addFromLibrary(libZone) {
    // New id so a library zone can be reused across games without collisions.
    await this.addZone(libZone.name, libZone.polygon, { toLibrary: false });
  }

  // ---- Zones panel (bottom sheet) ----
  async openPanel() {
    const g = store.getCurrent();
    const lib = await this.listLibrary();
    const zonesHtml = g.zones.length
      ? g.zones.map((z) => `
          <li>
            <span class="li-name">${escapeHtml(z.name)}</span>
            <button class="btn btn-ghost btn-sm" data-del="${z.id}">Remove</button>
          </li>`).join("")
      : `<li class="muted">No zones yet — draw or import one.</li>`;
    const libHtml = lib.length
      ? lib.map((z) => `
          <li>
            <span class="li-name">${escapeHtml(z.name)}</span>
            <span class="li-actions">
              <button class="btn btn-ghost btn-sm" data-add="${z.id}">Add</button>
              <button class="btn btn-ghost btn-sm" data-libdel="${z.id}">🗑</button>
            </span>
          </li>`).join("")
      : `<li class="muted">Library is empty.</li>`;

    const sum = g.gameArea ? areaSummary(g.gameArea, g.settings?.units) : null;
    const areaLine = sum ? `<p class="muted">Game area: <strong>${escapeHtml(sum.sizeTxt)}</strong> · ${escapeHtml(sum.tier)}</p>` : "";
    const s = openSheet({
      title: "Zones",
      bodyHTML: `
        <div class="row">
          <button id="z-region" class="btn btn-primary">🌍 Region boundary (reference)</button>
        </div>
        <div class="row">
          <button id="z-draw" class="btn">✎ Draw zone</button>
          <button id="z-import" class="btn">⇩ Import</button>
        </div>
        <h3 class="sub">In this game</h3>
        ${areaLine}
        <ul class="list">${zonesHtml}</ul>
        <h3 class="sub">Zone library</h3>
        <ul class="list">${libHtml}</ul>`,
    });

    s.q("#z-region").onclick = () => this._openRegionSearch();
    s.q("#z-draw").onclick = () => { s.close(); this.startDraw(); };
    s.q("#z-import").onclick = () => this._openImport();
    s.qa("[data-del]").forEach((b) => (b.onclick = () => { this.removeZone(b.dataset.del); s.close(); this.openPanel(); }));
    s.qa("[data-add]").forEach((b) => (b.onclick = async () => {
      await this.addFromLibrary(lib.find((x) => x.id === b.dataset.add));
      s.close();
    }));
    s.qa("[data-libdel]").forEach((b) => (b.onclick = async () => {
      await this.deleteFromLibrary(b.dataset.libdel);
      s.close(); this.openPanel();
    }));
  }

  _openImport() {
    const s = openSheet({
      title: "Import zone",
      bodyHTML: `
        <p class="muted">Paste GeoJSON (Polygon / Feature / FeatureCollection) or a coordinate list (one <code>lat,lng</code> per line).</p>
        <textarea id="imp" class="field" rows="8" placeholder='{"type":"Polygon","coordinates":[[[72.82,19.09],[72.84,19.09],[72.84,19.11],[72.82,19.11],[72.82,19.09]]]}'></textarea>
        <div class="sheet-actions">
          <button id="imp-cancel" class="btn btn-ghost">Cancel</button>
          <button id="imp-go" class="btn btn-primary">Import</button>
        </div>`,
    });
    s.q("#imp-cancel").onclick = () => s.close();
    s.q("#imp-go").onclick = async () => {
      const n = await this.importText(s.q("#imp").value);
      s.close();
      if (n) this.openPanel();
    };
  }

  // Search a place (Singapore, Switzerland…) and overlay its OFFICIAL Google
  // boundary as a REFERENCE only — it is never added as a zone. The user then
  // hand-plots their own points with ✎ Draw. Searching again leaves any drawn
  // zones untouched; overlays are a separate, purely-visual layer.
  _openRegionSearch() {
    if (!this.boundaries) { toast("Boundary reference isn’t available."); return; }
    const s = openSheet({
      title: "Region boundary",
      bodyHTML: `
        <p class="muted">Overlay a place's <strong>official Google boundary</strong> as a reference. It is <em>not</em> added as a zone — use ✎ Draw to hand-plot your own points along it. Your drawn zones stay put when you search again.</p>
        <input id="rg-q" class="field" placeholder="e.g. Singapore, Switzerland" />
        <div class="sheet-actions">
          <button id="rg-clear" class="btn btn-ghost">Clear overlays</button>
          <button id="rg-go" class="btn btn-primary">Search</button>
        </div>
        <ul id="rg-res" class="list"></ul>`,
    });
    s.q("#rg-q").focus();
    const run = async () => {
      const q = s.q("#rg-q").value.trim();
      if (!q) return;
      s.q("#rg-res").innerHTML = '<li class="muted">Searching…</li>';
      let results = [];
      try {
        results = await this.boundaries.search(q);
      } catch (e) {
        s.q("#rg-res").innerHTML = `<li class="muted">${escapeHtml(e.message)}</li>`;
        return;
      }
      if (!results.length) {
        s.q("#rg-res").innerHTML = '<li class="muted">No matching places.</li>';
        return;
      }
      this._regionResults = results;
      s.q("#rg-res").innerHTML = results
        .map((r, i) => {
          const primary = (r.types || [])[0]?.replace(/_/g, " ") || "place";
          return `<li>
            <div class="game-meta">
              <span class="li-name">${escapeHtml(r.formatted_address || "")}</span>
              <span class="muted">${escapeHtml(primary)}</span>
            </div>
            <button class="btn btn-ghost btn-sm" data-show="${i}">Show</button>
          </li>`;
        })
        .join("");
      s.qa("[data-show]").forEach((b) => (b.onclick = () => {
        const r = this._regionResults[parseInt(b.dataset.show, 10)];
        const { mode, reason } = this.boundaries.show(r);
        s.close();
        if (mode === "exact") {
          toast("Boundary overlaid — trace it with ✎ Draw to make it a zone.");
        } else if (reason === "dds-not-configured") {
          toast("Approx box only — your Map ID has no boundary layers enabled for Data-driven styling in the Google Cloud console.", 6000);
        } else if (reason === "no-map-id") {
          toast("Approx box — add a Data-driven-styling Map ID in Settings for the exact outline. Trace it with ✎ Draw.", 6000);
        } else {
          toast("Approx box shown — trace it with ✎ Draw to make it a zone.");
        }
      }));
    };
    s.q("#rg-clear").onclick = () => { this.boundaries.clear(); toast("Reference overlays cleared."); };
    s.q("#rg-go").onclick = run;
    s.q("#rg-q").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  }

  // ---- Rendering ----
  render() {
    const g = store.getCurrent();
    this._clear();
    if (!g) return;
    for (const z of g.zones) {
      const paths = z.polygon.map(([lat, lng]) => ({ lat, lng }));
      this.zonePolys.push(new google.maps.Polygon({ ...zoneStyle(), paths, map: this.map, clickable: false }));
    }
    if (g.gameArea) {
      for (const path of geojsonToPaths(g.gameArea)) {
        this.areaPolys.push(new google.maps.Polygon({ ...areaStyle(), paths: path, map: this.map, clickable: false }));
      }
    }
  }

  _clear() {
    this.zonePolys.forEach((p) => p.setMap(null));
    this.areaPolys.forEach((p) => p.setMap(null));
    this.zonePolys = [];
    this.areaPolys = [];
  }

  fitToArea() {
    const g = store.getCurrent();
    if (!g || !g.zones.length) return;
    const b = new google.maps.LatLngBounds();
    for (const z of g.zones) for (const [lat, lng] of z.polygon) b.extend({ lat, lng });
    if (!b.isEmpty()) this.map.fitBounds(b, 64);
  }
}

// A small bottom-sheet prompt for a zone name. Resolves to the name, or null if cancelled.
function promptZoneName(initial) {
  return new Promise((resolve) => {
    let done = false;
    const s = openSheet({
      title: "Name this zone",
      bodyHTML: `
        <input id="zn-name" class="field" type="text" placeholder="e.g. Marina Bay" value="${escapeHtml(initial)}" />
        <div class="sheet-actions">
          <button id="zn-cancel" class="btn btn-ghost">Cancel</button>
          <button id="zn-save" class="btn btn-primary">Save zone</button>
        </div>`,
      onClose: () => { if (!done) resolve(null); },
    });
    const input = s.q("#zn-name");
    input.focus();
    s.q("#zn-save").addEventListener("click", () => {
      done = true;
      const v = input.value.trim();
      s.close();
      resolve(v);
    });
    s.q("#zn-cancel").addEventListener("click", () => s.close());
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") s.q("#zn-save").click(); });
  });
}
