// Elimination layers: manages the history of elimination steps, renders each
// enabled step's shaded region + the remaining active area, and provides
// backtracking (undo / redo / per-layer toggle). Also hosts the tool input flows
// for Radar and Thermometer (guide §5.1, §5.2, §6.2).
import * as store from "./store.js";
import { createStep } from "./model.js";
import { geojsonToPathGroups } from "./geo.js";
import { computeElimination, computeActiveArea, describeStep, distancePointToArea } from "./tools.js";
import { searchCategory } from "./places.js";
import { TENTACLES, findTentacle, MATCHING, findMatching, MEASURING, findMeasuring } from "./data/questions.js";
import { openSheet, closeSheet, toast, escapeHtml, promptText } from "./ui.js";

// Instead of tinting the still-possible area (which read too much like the drawn
// zones), we shade EVERYTHING outside it: MASK_STYLE fills the excluded region
// dark, ACTIVE_OUTLINE draws a crisp bright edge around the remaining play area.
const MASK_STYLE = { fillColor: "#020a0c", fillOpacity: 0.55, strokeOpacity: 0, clickable: false };
const ACTIVE_OUTLINE = { fillOpacity: 0, strokeColor: "#34d399", strokeOpacity: 0.95, strokeWeight: 3, clickable: false };

// World rectangle minus `area` → the region to shade (everything but the play
// area), with `area` as a hole. Kept within valid lat/lng so it never crosses the
// antimeridian or poles; the map only ever shows the part around the play area.
function maskOutside(area) {
  const turf = window.turf;
  if (!turf || !area) return null;
  const world = turf.polygon([[[-179.9, -85], [179.9, -85], [179.9, 85], [-179.9, 85], [-179.9, -85]]]);
  try {
    const diff = turf.difference(turf.featureCollection([world, turf.feature(area)]));
    return diff ? diff.geometry : null;
  } catch (e) { console.warn("mask failed", e); return null; }
}
const CIRCLE_GUIDE = { strokeColor: "#38bdf8", strokeOpacity: 0.9, strokeWeight: 2, fillOpacity: 0 };
const LINE_GUIDE = { strokeColor: "#38bdf8", strokeOpacity: 0.95, strokeWeight: 3 };

export class Layers {
  constructor(map) {
    this.map = map;
    this.overlays = [];
    this.redoStack = [];
    this._pick = null;
  }

  init() {
    store.subscribe(() => this.render());
    this.render();
  }

  // ---- History operations ----
  addStep(tool, inputs, answer) {
    const step = createStep({ tool, inputs, answer, enabled: true });
    store.update((g) => g.history.push(step));
    this.redoStack = [];
    return step;
  }
  toggle(id) {
    store.update((g) => {
      const s = g.history.find((x) => x.id === id);
      if (s) s.enabled = !s.enabled;
    });
    this.redoStack = [];
  }
  remove(id) {
    store.update((g) => (g.history = g.history.filter((x) => x.id !== id)));
    this.redoStack = [];
  }
  undo() {
    const g = store.getCurrent();
    const enabled = g.history.filter((s) => s.enabled);
    if (!enabled.length) return toast("Nothing to undo.");
    const last = enabled[enabled.length - 1];
    store.update((gg) => {
      const s = gg.history.find((x) => x.id === last.id);
      if (s) s.enabled = false;
    });
    this.redoStack.push(last.id);
  }
  redo() {
    const id = this.redoStack.pop();
    if (!id) return toast("Nothing to redo.");
    store.update((g) => {
      const s = g.history.find((x) => x.id === id);
      if (s) s.enabled = true;
    });
  }

  // ---- Rendering ----
  render() {
    const g = store.getCurrent();
    this._clear();
    if (!g) return;

    // Per-question reference guides (circles / lines / points / outlines).
    for (const s of g.history) {
      if (!s.enabled) continue;
      const { guides } = computeElimination(s, g.gameArea);
      this._renderGuides(guides);
    }

    // Spotlight the still-possible area: shade everything OUTSIDE it and outline
    // its edge. As questions eliminate regions the active area shrinks and the
    // mask grows. With no questions yet, active === the game area, so this also
    // signals the play area from the start.
    if (g.gameArea) {
      const active = computeActiveArea(g.gameArea, g.history);
      const mask = maskOutside(active || g.gameArea);
      if (mask) {
        for (const group of geojsonToPathGroups(mask)) {
          this.overlays.push(new google.maps.Polygon({ ...MASK_STYLE, paths: group, map: this.map }));
        }
      }
      if (active) {
        for (const group of geojsonToPathGroups(active)) {
          this.overlays.push(new google.maps.Polygon({ ...ACTIVE_OUTLINE, paths: group, map: this.map }));
        }
      }
    }
  }

  _renderGuides(guides) {
    for (const gd of guides || []) {
      if (gd.type === "circle") {
        this.overlays.push(new google.maps.Circle({ ...CIRCLE_GUIDE, center: gd.center, radius: gd.radius, map: this.map, clickable: false }));
      } else if (gd.type === "line") {
        this.overlays.push(new google.maps.Polyline({ ...LINE_GUIDE, path: [gd.from, gd.to], map: this.map, clickable: false }));
      } else if (gd.type === "point") {
        this.overlays.push(new google.maps.Marker({ position: { lat: gd.lat, lng: gd.lng }, label: gd.label || "", map: this.map }));
      } else if (gd.type === "outline") {
        this.overlays.push(new google.maps.Polygon({ paths: gd.ring, strokeColor: "#94a3b8", strokeOpacity: 0.5, strokeWeight: 1, fillOpacity: 0, clickable: false, map: this.map }));
      } else if (gd.type === "polyline") {
        this.overlays.push(new google.maps.Polyline({ path: gd.coords, strokeColor: "#38bdf8", strokeOpacity: 0.9, strokeWeight: 3, clickable: false, map: this.map }));
      }
    }
  }

  _clear() {
    this.overlays.forEach((o) => o.setMap(null));
    this.overlays = [];
  }

  // ---- Map point picking (shared by tool flows) ----
  pick(count, hintText) {
    return new Promise((resolve) => {
      closeSheet();
      const pts = [];
      const markers = [];
      const bar = document.createElement("div");
      bar.className = "draw-bar";
      bar.innerHTML = `<span class="draw-count">${hintText}</span><button class="btn btn-ghost btn-sm" data-cancel>Cancel</button>`;
      document.body.appendChild(bar);

      const cleanup = () => {
        google.maps.event.removeListener(listener);
        markers.forEach((m) => m.setMap(null));
        bar.remove();
        this.map.setOptions({ draggableCursor: null });
      };
      const listener = this.map.addListener("click", (e) => {
        pts.push({ lat: e.latLng.lat(), lng: e.latLng.lng() });
        markers.push(new google.maps.Marker({ position: e.latLng, label: `${pts.length}`, map: this.map }));
        if (pts.length >= count) {
          cleanup();
          resolve(pts);
        }
      });
      bar.querySelector("[data-cancel]").addEventListener("click", () => {
        cleanup();
        resolve(null);
      });
      this.map.setOptions({ draggableCursor: "crosshair" });
    });
  }

  // Draw a line/path (minPts 2) or region outline (minPts 3) by tapping the map.
  // Resolves to [{lat,lng}, ...] or null if cancelled.
  _drawShape(minPts, hint) {
    return new Promise((resolve) => {
      closeSheet();
      const pts = [];
      const markers = [];
      let preview = null;
      const bar = document.createElement("div");
      bar.className = "draw-bar";
      bar.innerHTML = `<span class="draw-count">${escapeHtml(hint)} · 0</span>
        <button class="btn btn-ghost btn-sm" data-undo>Undo</button>
        <button class="btn btn-ghost btn-sm" data-cancel>Cancel</button>
        <button class="btn btn-primary btn-sm" data-finish>Finish</button>`;
      document.body.appendChild(bar);

      const setCount = () => { const c = bar.querySelector(".draw-count"); if (c) c.textContent = `${hint} · ${pts.length}`; };
      const redraw = () => {
        if (preview) { preview.setMap(null); preview = null; }
        if (pts.length >= 2) preview = new google.maps.Polyline({ path: pts, strokeColor: "#38bdf8", strokeWeight: 3, map: this.map, clickable: false });
      };
      const cleanup = () => {
        google.maps.event.removeListener(listener);
        if (preview) preview.setMap(null);
        markers.forEach((m) => m.setMap(null));
        bar.remove();
        this.map.setOptions({ draggableCursor: null });
      };
      const listener = this.map.addListener("click", (e) => {
        pts.push({ lat: e.latLng.lat(), lng: e.latLng.lng() });
        markers.push(new google.maps.Marker({ position: e.latLng, label: `${pts.length}`, map: this.map }));
        setCount(); redraw();
      });
      bar.querySelector("[data-undo]").onclick = () => { pts.pop(); const m = markers.pop(); if (m) m.setMap(null); setCount(); redraw(); };
      bar.querySelector("[data-cancel]").onclick = () => { cleanup(); resolve(null); };
      bar.querySelector("[data-finish]").onclick = () => {
        if (pts.length < minPts) { toast(`Add at least ${minPts} point${minPts === 1 ? "" : "s"}.`); return; }
        cleanup(); resolve(pts.slice());
      };
      this.map.setOptions({ draggableCursor: "crosshair" });
    });
  }

  // Minimal yes/no confirm sheet. Resolves true (Yes) / false (No or dismiss).
  _confirm(msg) {
    return new Promise((resolve) => {
      let done = false;
      const s = openSheet({
        title: "Confirm",
        bodyHTML: `<p>${escapeHtml(msg)}</p>
          <div class="sheet-actions"><button id="cf-no" class="btn btn-ghost">No</button><button id="cf-yes" class="btn btn-primary">Yes</button></div>`,
        onClose: () => { if (!done) resolve(false); },
      });
      s.q("#cf-no").onclick = () => { done = true; s.close(); resolve(false); };
      s.q("#cf-yes").onclick = () => { done = true; s.close(); resolve(true); };
    });
  }

  // ---- Panel ----
  openPanel() {
    const g = store.getCurrent();
    const canRedo = this.redoStack.length > 0;
    const rows = g.history.length
      ? g.history.map((s) => `
          <li>
            <label class="li-toggle">
              <input type="checkbox" data-toggle="${s.id}" ${s.enabled ? "checked" : ""} />
              <span class="li-name ${s.enabled ? "" : "off"}">${escapeHtml(s.title || describeStep(s))}</span>
            </label>
            <span class="li-actions">
              <button class="btn btn-ghost btn-sm" data-rename="${s.id}">✏️</button>
              <button class="btn btn-ghost btn-sm" data-del="${s.id}">🗑</button>
            </span>
          </li>`).join("")
      : `<li class="muted">No questions yet. Add one below.</li>`;

    const s = openSheet({
      title: "Questions",
      bodyHTML: `
        <div class="row">
          <button id="t-radar" class="btn btn-primary">◎ Radar</button>
          <button id="t-thermo" class="btn btn-primary">🌡 Thermometer</button>
        </div>
        <div class="row">
          <button id="t-match" class="btn btn-primary">🧭 Matching</button>
          <button id="t-tent" class="btn btn-primary">🐙 Tentacles</button>
        </div>
        <div class="row">
          <button id="t-measure" class="btn btn-primary">📐 Measuring</button>
        </div>
        <div class="row">
          <button id="t-undo" class="btn">↶ Undo</button>
          <button id="t-redo" class="btn" ${canRedo ? "" : "disabled"}>↷ Redo</button>
        </div>
        <h3 class="sub">Questions</h3>
        <ul class="list">${rows}</ul>`,
    });

    s.q("#t-radar").onclick = () => this.startRadar();
    s.q("#t-thermo").onclick = () => this.startThermometer();
    s.q("#t-match").onclick = () => this.startMatching();
    s.q("#t-tent").onclick = () => this.startTentacles();
    s.q("#t-measure").onclick = () => this.startMeasuring();
    s.q("#t-undo").onclick = () => { this.undo(); s.close(); this.openPanel(); };
    s.q("#t-redo").onclick = () => { this.redo(); s.close(); this.openPanel(); };
    s.qa("[data-toggle]").forEach((c) => (c.onchange = () => this.toggle(c.dataset.toggle)));
    s.qa("[data-del]").forEach((b) => (b.onclick = () => { this.remove(b.dataset.del); s.close(); this.openPanel(); }));
    s.qa("[data-rename]").forEach((b) => (b.onclick = async () => {
      const step = store.getCurrent().history.find((x) => x.id === b.dataset.rename);
      const name = await promptText({ title: "Rename question", label: "Question", value: step?.title || describeStep(step), cta: "Save" });
      if (name === null) return;
      store.update((g) => { const st = g.history.find((x) => x.id === b.dataset.rename); if (st) st.title = name || undefined; });
      this.openPanel();
    }));
  }

  // ---- Radar flow ----
  async startRadar() {
    const pts = await this.pick(1, "Tap the radar centre on the map.");
    if (!pts) return this.openPanel();
    const center = pts[0];
    const s = openSheet({
      title: "Radar",
      bodyHTML: `
        <p class="muted">“Are you within this distance of the point?”</p>
        <label class="fieldlbl">Radius (metres)</label>
        <input id="r-radius" class="field" type="number" inputmode="numeric" value="1000" min="10" step="10" />
        <div class="seg" role="radiogroup" aria-label="Answer">
          <label><input type="radio" name="r-side" value="in" checked /> Yes — inside</label>
          <label><input type="radio" name="r-side" value="out" /> No — outside</label>
        </div>
        <div class="sheet-actions">
          <button id="r-cancel" class="btn btn-ghost">Cancel</button>
          <button id="r-add" class="btn btn-primary">Add question</button>
        </div>`,
    });
    s.q("#r-cancel").onclick = () => s.close();
    s.q("#r-add").onclick = () => {
      const radius = Math.max(10, parseFloat(s.q("#r-radius").value) || 0);
      const side = s.qa('input[name="r-side"]').find((r) => r.checked)?.value || "in";
      this.addStep("radar", { center, radius }, { side });
      s.close();
      toast("Radar question added.");
    };
  }

  // ---- Thermometer flow ----
  async startThermometer() {
    const pts = await this.pick(2, "Tap point A (start), then point B (end).");
    if (!pts || pts.length < 2) return this.openPanel();
    const [a, b] = pts;
    const s = openSheet({
      title: "Thermometer",
      bodyHTML: `
        <p class="muted">Moving A → B, are you hotter (closer) or colder (farther)?</p>
        <div class="seg" role="radiogroup" aria-label="Answer">
          <label><input type="radio" name="th-side" value="hotter" checked /> Hotter (closer to B)</label>
          <label><input type="radio" name="th-side" value="colder" /> Colder (closer to A)</label>
        </div>
        <div class="sheet-actions">
          <button id="th-cancel" class="btn btn-ghost">Cancel</button>
          <button id="th-add" class="btn btn-primary">Add question</button>
        </div>`,
    });
    s.q("#th-cancel").onclick = () => s.close();
    s.q("#th-add").onclick = () => {
      const side = s.qa('input[name="th-side"]').find((r) => r.checked)?.value || "hotter";
      this.addStep("thermometer", { a, b }, { side });
      s.close();
      toast("Thermometer question added.");
    };
  }

  // ---- Matching / Tentacles (shared Voronoi flow) ----
  _searchParams(gameArea) {
    const turf = window.turf;
    const c = turf.centroid(turf.feature(gameArea)).geometry.coordinates; // [lng,lat]
    const bb = turf.bbox(turf.feature(gameArea));
    const diag = turf.distance([bb[0], bb[1]], [bb[2], bb[3]], { units: "meters" });
    return { center: { lat: c[1], lng: c[0] }, radius: Math.min(50000, Math.max(500, (diag / 2) * 1.2)) };
  }

  // ---- Matching (only the game's cards; reveal hider's value, keep region) ----
  async startMatching() {
    const g = store.getCurrent();
    if (!g?.gameArea) return toast("Add zones first to define the search area.");
    const opts = MATCHING.map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join("");
    const s = openSheet({
      title: "Matching",
      bodyHTML: `
        <p class="muted">You (the seeker) ask “is your nearest ___ the same as mine?” Enter <em>your</em> answer, then tap Yes (hider matches) or No (hider differs) — the app keeps or removes your region accordingly.</p>
        <label class="fieldlbl">Question</label>
        <select id="mt-cat" class="field">${opts}</select>
        <div class="sheet-actions">
          <button id="mt-cancel" class="btn btn-ghost">Cancel</button>
          <button id="mt-next" class="btn btn-primary">Next</button>
        </div>
        <p id="mt-status" class="muted"></p>`,
    });
    s.q("#mt-cancel").onclick = () => s.close();
    s.q("#mt-next").onclick = async () => {
      const card = findMatching(s.q("#mt-cat").value);
      if (card.mode === "nearest") return this._matchNearest(card, s);
      if (card.mode === "nameLength") return this._matchNameLength(card, s);
      if (card.mode === "nearestLine") { s.close(); return this._matchNearestLine(card); }
      if (card.mode === "region") { s.close(); return this._matchRegion(card); }
    };
  }

  // Nearest-of-a-category via Places → keep the hider's Voronoi cell.
  async _matchNearest(card, s) {
    const g = store.getCurrent();
    const { center, radius } = this._searchParams(g.gameArea);
    s.q("#mt-status").textContent = "Searching…";
    let feats = [];
    try {
      feats = await searchCategory(this.map, { center, radius, type: card.type, keyword: card.keyword });
    } catch (e) { s.q("#mt-status").textContent = e.message; return; }
    feats = feats.slice(0, 20);
    if (feats.length < 2) { s.q("#mt-status").textContent = `Found ${feats.length}. Need at least 2 to partition.`; return; }
    s.close();
    const temp = feats.map((f, i) => new google.maps.Marker({ position: { lat: f.lat, lng: f.lng }, label: `${i + 1}`, map: this.map }));
    const list = feats.map((f, i) => `<label><input type="radio" name="mt-feat" value="${i}" ${i === 0 ? "checked" : ""}/> ${i + 1}. ${escapeHtml(f.name)}</label>`).join("");
    const s2 = openSheet({
      title: card.label,
      bodyHTML: `
        <p class="muted">Which is <strong>your</strong> nearest ${escapeHtml(card.label.toLowerCase())}?</p>
        <div class="seg">${list}</div>
        <label class="fieldlbl">Did the hider answer the same?</label>
        <div class="seg" role="radiogroup">
          <label><input type="radio" name="mt-match" value="yes" checked/> Yes — same (keep this region)</label>
          <label><input type="radio" name="mt-match" value="no"/> No — different (remove this region)</label>
        </div>
        <div class="sheet-actions"><button id="mt-cancel2" class="btn btn-ghost">Cancel</button><button id="mt-add" class="btn btn-primary">Add question</button></div>`,
      onClose: () => temp.forEach((m) => m.setMap(null)),
    });
    s2.q("#mt-cancel2").onclick = () => s2.close();
    s2.q("#mt-add").onclick = () => {
      const featureIndex = parseInt(s2.qa('input[name="mt-feat"]').find((r) => r.checked)?.value ?? "0", 10);
      const keep = (s2.qa('input[name="mt-match"]').find((r) => r.checked)?.value ?? "yes") === "yes";
      this.addStep("matching", { mode: "nearest", category: card.id, categoryLabel: card.label, features: feats }, { featureIndex, keep });
      s2.close();
      toast("Matching question added.");
    };
  }

  // Nearest transit station grouped by name letter-count.
  async _matchNameLength(card, s) {
    const g = store.getCurrent();
    const { center, radius } = this._searchParams(g.gameArea);
    s.q("#mt-status").textContent = "Searching stations…";
    let feats = [];
    try {
      feats = await searchCategory(this.map, { center, radius, type: card.type });
    } catch (e) { s.q("#mt-status").textContent = e.message; return; }
    // Count letters in the station name only — drop parenthetical qualifiers
    // (e.g. "Shinjuku Station (South Exit)") that aren't part of the name players
    // compare, then collapse whitespace before counting.
    const nameLen = (n) => ((n.replace(/\s*\([^)]*\)/g, "").match(/\p{L}/gu)) || []).length;
    feats = feats.slice(0, 20).map((f) => ({ ...f, len: nameLen(f.name) }));
    if (feats.length < 2) { s.q("#mt-status").textContent = `Found ${feats.length} stations. Need at least 2.`; return; }
    s.close();
    const temp = feats.map((f) => new google.maps.Marker({ position: { lat: f.lat, lng: f.lng }, label: `${f.len}`, map: this.map }));
    const lengths = [...new Set(feats.map((f) => f.len))].sort((a, b) => a - b);
    const list = lengths.map((L, i) => `<label><input type="radio" name="nl" value="${L}" ${i === 0 ? "checked" : ""}/> ${L} letters (${feats.filter((f) => f.len === L).length} station${feats.filter((f) => f.len === L).length === 1 ? "" : "s"})</label>`).join("");
    const s2 = openSheet({
      title: "Station's Name Length",
      bodyHTML: `
        <p class="muted">Nearest-station regions grouped by name length. Pick <strong>your</strong> nearest-station name length.</p>
        <div class="seg">${list}</div>
        <label class="fieldlbl">Did the hider answer the same length?</label>
        <div class="seg" role="radiogroup">
          <label><input type="radio" name="nl-match" value="yes" checked/> Yes — same (keep those regions)</label>
          <label><input type="radio" name="nl-match" value="no"/> No — different (remove those regions)</label>
        </div>
        <div class="sheet-actions"><button id="nl-cancel" class="btn btn-ghost">Cancel</button><button id="nl-add" class="btn btn-primary">Add question</button></div>`,
      onClose: () => temp.forEach((m) => m.setMap(null)),
    });
    s2.q("#nl-cancel").onclick = () => s2.close();
    s2.q("#nl-add").onclick = () => {
      const L = parseInt(s2.qa('input[name="nl"]').find((r) => r.checked)?.value ?? `${lengths[0]}`, 10);
      const match = (s2.qa('input[name="nl-match"]').find((r) => r.checked)?.value ?? "yes") === "yes";
      this.addStep("matching", { mode: "nameLength", category: card.id, categoryLabel: "station name length", features: feats }, { length: L, match });
      s2.close();
      toast("Matching question added.");
    };
  }

  // Nearest of several hand-drawn lines/paths (Transit Line, Street or Path).
  async _matchNearestLine(card) {
    const lines = [];
    // Keep each drawn line visible on the map while the next ones are drawn, so
    // the user can see what they've already placed (avoids duplicate/overlapping
    // lines). Cleared when the selection sheet closes or the flow is abandoned.
    const overlays = [];
    const clearOverlays = () => { overlays.forEach((o) => o.setMap(null)); overlays.length = 0; };
    for (;;) {
      const coords = await this._drawShape(2, `Draw ${card.label} #${lines.length + 1} — tap along it`);
      if (!coords) { if (!lines.length) { clearOverlays(); return this.openPanel(); } break; }
      const label = await promptText({ title: "Name this line", label: "Label", value: `${card.label} ${lines.length + 1}`, cta: "Save" });
      lines.push({ id: `ln_${lines.length}_${Date.now().toString(36)}`, label: label || `${card.label} ${lines.length + 1}`, coords });
      overlays.push(new google.maps.Polyline({ path: coords.map((c) => ({ lat: c.lat, lng: c.lng })), map: this.map, ...LINE_GUIDE, clickable: false }));
      if (!(await this._confirm(`Added ${lines.length}. Draw another ${card.label.toLowerCase()}?`))) break;
    }
    if (lines.length < 1) { clearOverlays(); return this.openPanel(); }
    const list = lines.map((l, i) => `<label><input type="radio" name="ln" value="${l.id}" ${i === 0 ? "checked" : ""}/> ${escapeHtml(l.label)}</label>`).join("");
    const s = openSheet({
      title: card.label,
      bodyHTML: `
        <p class="muted">Which ${escapeHtml(card.label.toLowerCase())} are <strong>you</strong> nearest to?</p>
        <div class="seg">${list}</div>
        <label class="fieldlbl">Did the hider answer the same one?</label>
        <div class="seg" role="radiogroup">
          <label><input type="radio" name="ln-match" value="yes" checked/> Yes — same (keep that region)</label>
          <label><input type="radio" name="ln-match" value="no"/> No — different (remove that region)</label>
        </div>
        <div class="sheet-actions"><button id="ln-cancel" class="btn btn-ghost">Cancel</button><button id="ln-add" class="btn btn-primary">Add question</button></div>`,
      onClose: () => clearOverlays(),
    });
    s.q("#ln-cancel").onclick = () => s.close();
    s.q("#ln-add").onclick = () => {
      const lineId = s.qa('input[name="ln"]').find((r) => r.checked)?.value ?? lines[0].id;
      const match = (s.qa('input[name="ln-match"]').find((r) => r.checked)?.value ?? "yes") === "yes";
      this.addStep("matching", { mode: "nearestLine", category: card.id, categoryLabel: card.label, lines }, { lineId, match });
      s.close();
      toast("Matching question added.");
    };
  }

  // Draw a [lat,lng] region and keep the hider's side. Shared by Matching (admin
  // divisions / landmass) and Measuring (sea level); onAdd(ring, inside) records
  // the tool-specific step.
  async _regionSideSheet({ drawHint, title, intro }, onAdd) {
    const pts = await this._drawShape(3, drawHint);
    if (!pts) return this.openPanel();
    const ring = pts.map((p) => [p.lat, p.lng]);
    const s = openSheet({
      title,
      bodyHTML: `
        <p class="muted">${intro}</p>
        <label class="fieldlbl">Did the hider answer the same?</label>
        <div class="seg" role="radiogroup">
          <label><input type="radio" name="rg" value="in" checked/> Yes — same (keep inside this region)</label>
          <label><input type="radio" name="rg" value="out"/> No — different (keep outside)</label>
        </div>
        <div class="sheet-actions"><button id="rg-cancel" class="btn btn-ghost">Cancel</button><button id="rg-add" class="btn btn-primary">Add question</button></div>`,
    });
    s.q("#rg-cancel").onclick = () => s.close();
    s.q("#rg-add").onclick = () => {
      const inside = (s.qa('input[name="rg"]').find((r) => r.checked)?.value ?? "in") === "in";
      onAdd(ring, inside);
      s.close();
    };
  }

  // Which drawn region the hider is inside (admin divisions, landmass).
  _matchRegion(card) {
    return this._regionSideSheet(
      { drawHint: `Outline the ${card.label} you (the seeker) are in`, title: card.label, intro: `Draw the ${card.label.toLowerCase()} you're in, then answer whether the hider is in the same one.` },
      (ring, inside) => {
        this.addStep("matching", { mode: "region", category: card.id, categoryLabel: card.label, ring }, { inside });
        toast("Matching question added.");
      },
    );
  }

  // ---- Tentacles (fixed-radius "which are you closest to?") ----
  async startTentacles() {
    const g = store.getCurrent();
    if (!g?.gameArea) return toast("Add zones first to define the search area.");
    const rTxt = (r) => (r >= 1000 ? `${r / 1000} km` : `${r} m`);
    const opts = TENTACLES.map((c) =>
      `<option value="${c.id}">${escapeHtml(c.label)} · ${rTxt(c.radius)}${c.approx ? ` (${escapeHtml(c.approx)})` : ""}</option>`
    ).join("");
    const s = openSheet({
      title: "Tentacles",
      bodyHTML: `
        <p class="muted">A fixed-radius “which of these are you closest to?” card. Pick one; the app finds those places near your play area.</p>
        <label class="fieldlbl">Card</label>
        <select id="tt-cat" class="field">${opts}</select>
        <div class="sheet-actions">
          <button id="tt-cancel" class="btn btn-ghost">Cancel</button>
          <button id="tt-find" class="btn btn-primary">Find places</button>
        </div>
        <p id="tt-status" class="muted"></p>`,
    });
    s.q("#tt-cancel").onclick = () => s.close();
    s.q("#tt-find").onclick = async () => {
      const cat = findTentacle(s.q("#tt-cat").value);
      const { center, radius } = this._searchParams(g.gameArea);
      const searchRadius = Math.min(50000, radius + cat.radius); // cover R around the area
      s.q("#tt-status").textContent = "Searching…";
      let feats = [];
      try {
        feats = await searchCategory(this.map, { center, radius: searchRadius, type: cat.type });
      } catch (e) {
        s.q("#tt-status").textContent = e.message;
        return;
      }
      // Distance bound: keep only places whose radius circle can reach the area.
      feats = feats.filter((f) => distancePointToArea(f, g.gameArea) <= cat.radius).slice(0, 20);
      if (!feats.length) {
        s.q("#tt-status").textContent = `No ${cat.label.toLowerCase()} within ${rTxt(cat.radius)} of your area.`;
        return;
      }
      s.close();
      this._chooseTentacle(cat, feats);
    };
  }

  _chooseTentacle(cat, features) {
    const rTxt = cat.radius >= 1000 ? `${cat.radius / 1000} km` : `${cat.radius} m`;
    const temp = features.map((f, i) =>
      new google.maps.Marker({ position: { lat: f.lat, lng: f.lng }, label: `${i + 1}`, map: this.map })
    );
    const list = features
      .map((f, i) => `<label><input type="radio" name="tt-feat" value="${i}" ${i === 0 ? "checked" : ""}/> ${i + 1}. ${escapeHtml(f.name)}</label>`)
      .join("");
    const s = openSheet({
      title: "Tentacles",
      bodyHTML: `
        <p class="muted">${escapeHtml(cat.label)} within ${rTxt}. Which is the hider closest to?</p>
        <div class="seg">${list}</div>
        <div class="seg"><label><input type="radio" name="tt-feat" value="none"/> None within ${rTxt} (hider is outside all)</label></div>
        <div class="sheet-actions">
          <button id="tt-cancel2" class="btn btn-ghost">Cancel</button>
          <button id="tt-add" class="btn btn-primary">Add question</button>
        </div>`,
      onClose: () => temp.forEach((m) => m.setMap(null)),
    });
    s.q("#tt-cancel2").onclick = () => s.close();
    s.q("#tt-add").onclick = () => {
      const val = s.qa('input[name="tt-feat"]').find((r) => r.checked)?.value ?? "0";
      const inputs = { category: cat.id, categoryLabel: cat.label, radius: cat.radius, features };
      const answer = val === "none" ? { none: true } : { featureIndex: parseInt(val, 10) };
      this.addStep("tentacles", inputs, answer);
      s.close();
      toast("Tentacles question added.");
    };
  }

  // ---- Measuring (only the game's 20 cards; buffer a reference, keep a side) ----
  // Point cards source the reference automatically from Places; line / area / region
  // cards fall back to an on-map draw because Google exposes no such geometry.
  async startMeasuring() {
    const g = store.getCurrent();
    if (!g?.gameArea) return toast("Add zones first to define the search area.");
    const opts = MEASURING.map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join("");
    const s = openSheet({
      title: "Measuring",
      bodyHTML: `
        <p class="muted">You (the seeker) ask “are you closer to / farther from the nearest ___ than me?” Enter <em>your</em> distance, then tap the hider's answer.</p>
        <label class="fieldlbl">Question</label>
        <select id="m-cat" class="field">${opts}</select>
        <div class="sheet-actions">
          <button id="m-cancel" class="btn btn-ghost">Cancel</button>
          <button id="m-next" class="btn btn-primary">Next</button>
        </div>
        <p id="m-status" class="muted"></p>`,
    });
    s.q("#m-cancel").onclick = () => s.close();
    s.q("#m-next").onclick = async () => {
      const card = findMeasuring(s.q("#m-cat").value);
      if (card.ref === "points") return this._measurePoints(card, s);
      s.close();
      if (card.ref === "line") return this._measureLine(card);
      if (card.ref === "area") return this._measureArea(card);
      if (card.ref === "region") return this._measureRegion(card);
    };
  }

  // Distance + within/beyond controls, shared by the buffer-based measuring cards.
  _distanceSheet(card, addInputs) {
    const s = openSheet({
      title: card.label,
      bodyHTML: `
        <p class="muted"><strong>Your</strong> distance to the nearest ${escapeHtml(card.label.toLowerCase())}. The app buffers by this distance, then keeps the side matching the hider's answer.</p>
        <label class="fieldlbl">Your distance (metres)</label>
        <input id="m-dist" class="field" type="number" inputmode="numeric" value="500" min="10" step="10" />
        <label class="fieldlbl">The hider is…</label>
        <div class="seg" role="radiogroup">
          <label><input type="radio" name="m-side" value="in" checked/> Closer than me (within — keep inside)</label>
          <label><input type="radio" name="m-side" value="out"/> Farther than me (beyond — keep outside)</label>
        </div>
        <div class="sheet-actions">
          <button id="m-cancel2" class="btn btn-ghost">Cancel</button>
          <button id="m-add" class="btn btn-primary">Add question</button>
        </div>`,
    });
    s.q("#m-cancel2").onclick = () => s.close();
    s.q("#m-add").onclick = () => {
      const distance = Math.max(10, parseFloat(s.q("#m-dist").value) || 0);
      const side = s.qa('input[name="m-side"]').find((r) => r.checked)?.value || "in";
      this.addStep("measuring", { ...addInputs, distance }, { side });
      s.close();
      toast("Measuring question added.");
    };
  }

  // Nearest-of-a-category buffered: source points from Places (fall back to a
  // single hand-marked point if none are found nearby).
  async _measurePoints(card, s) {
    const g = store.getCurrent();
    const { center, radius } = this._searchParams(g.gameArea);
    s.q("#m-status").textContent = "Searching…";
    let feats = [];
    try {
      feats = await searchCategory(this.map, { center, radius, type: card.type, keyword: card.keyword });
    } catch (e) { s.q("#m-status").textContent = e.message; return; }
    if (!feats.length) {
      s.close();
      const pts = await this._drawShape(1, `No ${card.label.toLowerCase()} found nearby — tap the nearest one on the map`);
      if (!pts) return this.openPanel();
      return this._distanceSheet(card, {
        refType: "points", refLabel: card.label,
        refGeometry: { type: "Point", coordinates: [pts[0].lng, pts[0].lat] },
        refFeatures: [{ ...pts[0], name: card.label }],
      });
    }
    s.close();
    this._distanceSheet(card, {
      refType: "points", refLabel: card.label,
      refGeometry: { type: "MultiPoint", coordinates: feats.map((f) => [f.lng, f.lat]) },
      refFeatures: feats,
    });
  }

  // A hand-drawn reference line (high-speed rail, coastline, borders): buffer it.
  async _measureLine(card) {
    const coords = await this._drawShape(2, `Draw the ${card.label} — tap along it`);
    if (!coords) return this.openPanel();
    this._distanceSheet(card, {
      refType: "line", refLabel: card.label,
      refGeometry: { type: "LineString", coordinates: coords.map((c) => [c.lng, c.lat]) },
    });
  }

  // A hand-drawn polygon (a body of water): buffer outward from its shore.
  async _measureArea(card) {
    const pts = await this._drawShape(3, `Outline the ${card.label} on the map`);
    if (!pts) return this.openPanel();
    const ring = pts.map((p) => [p.lng, p.lat]);
    ring.push([ring[0][0], ring[0][1]]);
    this._distanceSheet(card, {
      refType: "area", refLabel: card.label,
      refGeometry: { type: "Polygon", coordinates: [ring] },
    });
  }

  // Sea Level: elevation has no map geometry, so draw the region above/below the
  // revealed level and keep that side (no distance buffer).
  _measureRegion(card) {
    return this._regionSideSheet(
      {
        drawHint: `Outline your side of the ${card.label} boundary`,
        title: card.label,
        intro: `Draw the region on <strong>your</strong> side of the ${escapeHtml(card.label.toLowerCase())} boundary, then answer whether the hider is on the same side.`,
      },
      (ring, inside) => {
        this.addStep("measuring", { refType: "region", refLabel: card.label, ring }, { inside });
        toast("Measuring question added.");
      },
    );
  }
}
