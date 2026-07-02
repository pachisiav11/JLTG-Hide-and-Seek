// Elimination layers: manages the history of elimination steps, renders each
// enabled step's shaded region + the remaining active area, and provides
// backtracking (undo / redo / per-layer toggle). Also hosts the tool input flows
// for Radar and Thermometer (guide §5.1, §5.2, §6.2).
import * as store from "./store.js";
import { createStep } from "./model.js";
import { geojsonToPaths } from "./geo.js";
import { computeElimination, computeActiveArea, describeStep, autoAnswer } from "./tools.js";
import { CATEGORIES, searchCategory } from "./places.js";
import { LINEAR_FEATURES, findLinearFeature } from "./data/linear.js";
import { openSheet, closeSheet, toast, escapeHtml, promptText } from "./ui.js";

const ELIM_STYLE = { fillColor: "#ef4444", fillOpacity: 0.25, strokeColor: "#ef4444", strokeOpacity: 0.55, strokeWeight: 1 };
const ACTIVE_STYLE = { fillColor: "#34d399", fillOpacity: 0.08, strokeColor: "#34d399", strokeOpacity: 0.95, strokeWeight: 3 };
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

  // The locked hider point, or null. Used to auto-answer tool questions.
  _lock() {
    const g = store.getCurrent();
    return g?.hiderLock?.locked ? g.hiderLock.point : null;
  }
  // HTML for the "auto-answer from lock" checkbox, shown only when locked.
  _autoHtml() {
    return this._lock()
      ? `<label class="auto"><input type="checkbox" id="auto" checked/> 🔒 Auto-answer from hider lock</label>`
      : "";
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

    for (const s of g.history) {
      if (!s.enabled) continue;
      const { eliminated, guides } = computeElimination(s, g.gameArea);
      if (eliminated) {
        for (const path of geojsonToPaths(eliminated)) {
          this.overlays.push(new google.maps.Polygon({ ...ELIM_STYLE, paths: path, map: this.map, clickable: false }));
        }
      }
      this._renderGuides(guides);
    }

    const active = computeActiveArea(g.gameArea, g.history);
    if (active && g.history.some((s) => s.enabled)) {
      for (const path of geojsonToPaths(active)) {
        this.overlays.push(new google.maps.Polygon({ ...ACTIVE_STYLE, paths: path, map: this.map, clickable: false }));
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
    s.q("#t-match").onclick = () => this.startVoronoi("matching");
    s.q("#t-tent").onclick = () => this.startVoronoi("tentacles");
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
        ${this._autoHtml()}
        <div class="sheet-actions">
          <button id="r-cancel" class="btn btn-ghost">Cancel</button>
          <button id="r-add" class="btn btn-primary">Add question</button>
        </div>`,
    });
    s.q("#r-cancel").onclick = () => s.close();
    s.q("#r-add").onclick = () => {
      const radius = Math.max(10, parseFloat(s.q("#r-radius").value) || 0);
      const inputs = { center, radius };
      const lock = this._lock();
      const answer = lock && s.q("#auto")?.checked
        ? autoAnswer("radar", inputs, lock)
        : { side: s.qa('input[name="r-side"]').find((r) => r.checked)?.value || "in" };
      this.addStep("radar", inputs, answer);
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
        ${this._autoHtml()}
        <div class="sheet-actions">
          <button id="th-cancel" class="btn btn-ghost">Cancel</button>
          <button id="th-add" class="btn btn-primary">Add question</button>
        </div>`,
    });
    s.q("#th-cancel").onclick = () => s.close();
    s.q("#th-add").onclick = () => {
      const inputs = { a, b };
      const lock = this._lock();
      const answer = lock && s.q("#auto")?.checked
        ? autoAnswer("thermometer", inputs, lock)
        : { side: s.qa('input[name="th-side"]').find((r) => r.checked)?.value || "hotter" };
      this.addStep("thermometer", inputs, answer);
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

  async startVoronoi(kind) {
    const g = store.getCurrent();
    if (!g?.gameArea) return toast("Add zones first to define the search area.");
    const title = kind === "matching" ? "Matching" : "Tentacles";
    const catOpts = CATEGORIES.map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join("");
    const s = openSheet({
      title,
      bodyHTML: `
        <label class="fieldlbl">Category</label>
        <select id="v-cat" class="field">${catOpts}</select>
        <label class="fieldlbl">Keyword (optional)</label>
        <input id="v-kw" class="field" placeholder="e.g. McDonald's" />
        <div class="sheet-actions">
          <button id="v-cancel" class="btn btn-ghost">Cancel</button>
          <button id="v-find" class="btn btn-primary">Find places</button>
        </div>
        <p id="v-status" class="muted"></p>`,
    });
    s.q("#v-cancel").onclick = () => s.close();
    s.q("#v-find").onclick = async () => {
      const cat = CATEGORIES.find((c) => c.id === s.q("#v-cat").value);
      const keyword = s.q("#v-kw").value.trim();
      const { center, radius } = this._searchParams(g.gameArea);
      s.q("#v-status").textContent = "Searching…";
      let features = [];
      try {
        features = await searchCategory(this.map, { center, radius, type: cat.type, keyword });
      } catch (e) {
        s.q("#v-status").textContent = e.message;
        return;
      }
      features = features.slice(0, 20);
      if (features.length < 2) {
        s.q("#v-status").textContent = `Found ${features.length}. Need at least 2 to partition.`;
        return;
      }
      s.close();
      this._chooseFeature(kind, cat, features);
    };
  }

  _chooseFeature(kind, cat, features) {
    const temp = features.map((f, i) =>
      new google.maps.Marker({ position: { lat: f.lat, lng: f.lng }, label: `${i + 1}`, map: this.map })
    );
    const list = features
      .map((f, i) => `<label><input type="radio" name="v-feat" value="${i}" ${i === 0 ? "checked" : ""}/> ${i + 1}. ${escapeHtml(f.name)}</label>`)
      .join("");
    const matchingExtra = kind === "matching"
      ? `<h3 class="sub">Answer</h3>
         <div class="seg">
           <label><input type="radio" name="v-ans" value="yes" checked/> Yes — same nearest (keep this cell)</label>
           <label><input type="radio" name="v-ans" value="no"/> No — different (shade this cell)</label>
         </div>`
      : "";
    const prompt = kind === "matching"
      ? "Which is the hider’s nearest one?"
      : "Which one is the hider closest to? (keeps that cell)";
    const s = openSheet({
      title: kind === "matching" ? "Matching" : "Tentacles",
      bodyHTML: `
        <p class="muted">${prompt} (${features.length} found)</p>
        <div class="seg">${list}</div>
        ${matchingExtra}
        ${this._autoHtml()}
        <div class="sheet-actions">
          <button id="v-cancel2" class="btn btn-ghost">Cancel</button>
          <button id="v-add" class="btn btn-primary">Add question</button>
        </div>`,
      onClose: () => temp.forEach((m) => m.setMap(null)),
    });
    s.q("#v-cancel2").onclick = () => s.close();
    s.q("#v-add").onclick = () => {
      const inputs = { category: cat.id, categoryLabel: cat.label, features };
      const lock = this._lock();
      let answer;
      if (lock && s.q("#auto")?.checked) {
        answer = autoAnswer(kind, inputs, lock);
      } else {
        const featureIndex = parseInt(s.qa('input[name="v-feat"]').find((r) => r.checked)?.value ?? "0", 10);
        const keep = kind === "matching"
          ? s.qa('input[name="v-ans"]').find((r) => r.checked)?.value === "yes"
          : true; // Tentacles always keeps the revealed-closest cell
        answer = { featureIndex, keep };
      }
      this.addStep(kind, inputs, answer);
      s.close();
      toast(`${kind === "matching" ? "Matching" : "Tentacles"} question added.`);
    };
  }

  // ---- Measuring (buffer of a reference: bundled line or Places points) ----
  startMeasuring() {
    const g = store.getCurrent();
    if (!g?.gameArea) return toast("Add zones first to define the search area.");
    const lineOpts = LINEAR_FEATURES.map((f) => `<option value="line:${f.id}">${escapeHtml(f.name)}</option>`).join("");
    const placeOpts = CATEGORIES.map((c) => `<option value="places:${c.id}">Nearest ${escapeHtml(c.label.toLowerCase())}</option>`).join("");
    const s = openSheet({
      title: "Measuring",
      bodyHTML: `
        <p class="muted">Buffer a reference feature by a distance, then keep the matching side.</p>
        <label class="fieldlbl">Reference</label>
        <select id="m-ref" class="field">
          <optgroup label="Bundled linear features">${lineOpts}</optgroup>
          <optgroup label="Nearest place (Places API)">${placeOpts}</optgroup>
        </select>
        <label class="fieldlbl">Distance (metres)</label>
        <input id="m-dist" class="field" type="number" inputmode="numeric" value="500" min="10" step="10" />
        <div class="seg" role="radiogroup">
          <label><input type="radio" name="m-side" value="in" checked/> Within (Yes / closer)</label>
          <label><input type="radio" name="m-side" value="out"/> Beyond (No / farther)</label>
        </div>
        ${this._autoHtml()}
        <div class="sheet-actions">
          <button id="m-cancel" class="btn btn-ghost">Cancel</button>
          <button id="m-add" class="btn btn-primary">Add question</button>
        </div>
        <p id="m-status" class="muted"></p>`,
    });
    s.q("#m-cancel").onclick = () => s.close();
    s.q("#m-add").onclick = async () => {
      const ref = s.q("#m-ref").value;
      const distance = Math.max(10, parseFloat(s.q("#m-dist").value) || 0);
      let inputs;
      if (ref.startsWith("line:")) {
        const lf = findLinearFeature(ref.slice(5));
        if (!lf) return;
        inputs = { refType: "line", refGeometry: lf.geojson, refLabel: lf.name, distance };
      } else {
        const cat = CATEGORIES.find((c) => c.id === ref.slice(7));
        const { center, radius } = this._searchParams(g.gameArea);
        s.q("#m-status").textContent = "Searching places…";
        let feats = [];
        try {
          feats = await searchCategory(this.map, { center, radius, type: cat.type });
        } catch (e) {
          s.q("#m-status").textContent = e.message;
          return;
        }
        if (!feats.length) {
          s.q("#m-status").textContent = "No places found for that reference.";
          return;
        }
        inputs = {
          refType: "places",
          refGeometry: { type: "MultiPoint", coordinates: feats.map((f) => [f.lng, f.lat]) },
          refFeatures: feats,
          refLabel: cat.label,
          distance,
        };
      }
      const lock = this._lock();
      const answer = lock && s.q("#auto")?.checked
        ? autoAnswer("measuring", inputs, lock)
        : { side: s.qa('input[name="m-side"]').find((r) => r.checked)?.value || "in" };
      this.addStep("measuring", inputs, answer);
      s.close();
      toast("Measuring question added.");
    };
  }
}
