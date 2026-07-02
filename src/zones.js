// Zone management: draw / import zones, maintain a reusable zone library, and
// assemble the game area (turf.union of all zones). Renders zones + the game-area
// boundary on the map and keeps everything persisted through the store.
import * as store from "./store.js";
import * as db from "./db.js";
import { createZone } from "./model.js";
import { geojsonToPaths, unionRings, parseZoneInput } from "./geo.js";
import { searchRegions, regionToRings } from "./regions.js";
import { openSheet, toast, escapeHtml } from "./ui.js";

const ZONE_STYLE = { strokeColor: "#2dd4bf", strokeOpacity: 0.95, strokeWeight: 1.5, fillColor: "#2dd4bf", fillOpacity: 0.12 };
const AREA_STYLE = { strokeColor: "#f2c14e", strokeOpacity: 0.95, strokeWeight: 3, fillOpacity: 0 };

export class Zones {
  constructor(map) {
    this.map = map;
    this.zonePolys = [];
    this.areaPolys = [];
    this._draw = null; // active drawing session
  }

  async init() {
    // Polygon/Polyline are in the core 'maps' library (already loaded). We draw
    // zones with a custom click-to-add tool (the old DrawingManager was removed
    // from the Maps JS API in v3.65).
    store.subscribe(() => this.render());
    this.render();
  }

  // ---- Custom polygon drawing ----
  startDraw() {
    if (this._draw) return;
    this._draw = { pts: [], preview: null, bar: null, listener: null };
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
      d.preview = new google.maps.Polygon({ ...ZONE_STYLE, paths: path, clickable: false, map: this.map });
    } else if (path.length >= 1) {
      d.preview = new google.maps.Polyline({ path, strokeColor: ZONE_STYLE.strokeColor, strokeWeight: 2, map: this.map });
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
    this._endDraw();
    const name = await promptZoneName("");
    if (name === null) return; // cancelled
    await this.addZone(name || `Zone ${store.getCurrent().zones.length + 1}`, ring, { toLibrary: true });
  }

  _endDraw() {
    const d = this._draw;
    if (!d) return;
    if (d.listener) google.maps.event.removeListener(d.listener);
    if (d.preview) d.preview.setMap(null);
    d.bar?.remove();
    this.map.setOptions({ draggableCursor: null });
    this._draw = null;
  }

  // ---- Add / remove ----
  async addZone(name, ring, { toLibrary = false } = {}) {
    const zone = createZone({ name, polygon: ring });
    store.update((g) => {
      g.zones.push(zone);
      g.gameArea = unionRings(g.zones.map((z) => z.polygon));
    });
    if (toLibrary) await this.saveToLibrary(zone);
    this.fitToArea();
    toast(`Added “${zone.name}”.`);
    return zone;
  }

  removeZone(id) {
    store.update((g) => {
      g.zones = g.zones.filter((z) => z.id !== id);
      g.gameArea = unionRings(g.zones.map((z) => z.polygon));
    });
  }

  // ---- Import (paste GeoJSON or coordinates) ----
  async importText(text) {
    const parsed = parseZoneInput(text);
    if (!parsed.length) {
      toast("Couldn’t parse any polygon from that input.");
      return 0;
    }
    for (const { name, ring } of parsed) {
      await this.addZone(name || `Imported zone`, ring, { toLibrary: true });
    }
    return parsed.length;
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

    const s = openSheet({
      title: "Zones",
      bodyHTML: `
        <div class="row">
          <button id="z-region" class="btn btn-primary">🌍 Add named region</button>
        </div>
        <div class="row">
          <button id="z-draw" class="btn">✎ Draw zone</button>
          <button id="z-import" class="btn">⇩ Import</button>
        </div>
        <h3 class="sub">In this game</h3>
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

  // Search a named region (Singapore, Switzerland…) and add its real boundary
  // as a zone. Add several to combine them into one game area (turf.union).
  _openRegionSearch() {
    const s = openSheet({
      title: "Add named region",
      bodyHTML: `
        <p class="muted">Type a place — neighbourhood, city, state, or country. Add several to combine them into the play area.</p>
        <input id="rg-q" class="field" placeholder="e.g. Singapore, Switzerland" />
        <div class="sheet-actions">
          <button id="rg-cancel" class="btn btn-ghost">Cancel</button>
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
        results = await searchRegions(q);
      } catch (e) {
        s.q("#rg-res").innerHTML = `<li class="muted">${escapeHtml(e.message)}</li>`;
        return;
      }
      if (!results.length) {
        s.q("#rg-res").innerHTML = '<li class="muted">No matching regions.</li>';
        return;
      }
      this._regionResults = results;
      s.q("#rg-res").innerHTML = results
        .map((r, i) => {
          const hasPoly = r.geojson && (r.geojson.type === "Polygon" || r.geojson.type === "MultiPolygon");
          return `<li>
            <div class="game-meta">
              <span class="li-name">${escapeHtml(r.shortName)}</span>
              <span class="muted">${escapeHtml(r.kind)}${hasPoly ? "" : " · box only"}</span>
            </div>
            <button class="btn btn-ghost btn-sm" data-add="${i}">Add</button>
          </li>`;
        })
        .join("");
      s.qa("[data-add]").forEach((b) => (b.onclick = async () => {
        const r = this._regionResults[parseInt(b.dataset.add, 10)];
        const rings = regionToRings(r);
        if (!rings.length) { toast("No boundary available for that result."); return; }
        for (let i = 0; i < rings.length; i++) {
          await this.addZone(rings.length > 1 ? `${r.shortName} (${i + 1})` : r.shortName, rings[i], { toLibrary: true });
        }
        s.close();
      }));
    };
    s.q("#rg-cancel").onclick = () => s.close();
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
      this.zonePolys.push(new google.maps.Polygon({ ...ZONE_STYLE, paths, map: this.map, clickable: false }));
    }
    if (g.gameArea) {
      for (const path of geojsonToPaths(g.gameArea)) {
        this.areaPolys.push(new google.maps.Polygon({ ...AREA_STYLE, paths: path, map: this.map, clickable: false }));
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
