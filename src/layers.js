// Elimination layers: manages the history of elimination steps, renders each
// enabled step's shaded region + the remaining active area, and provides
// backtracking (undo / redo / per-layer toggle). Also hosts the tool input flows
// for Radar and Thermometer (guide §5.1, §5.2, §6.2).
import * as store from "./store.js";
import { createStep } from "./model.js";
import { geojsonToPathGroups } from "./geo.js";
import { computeElimination, computeActiveArea, describeStep, distancePointToArea, checkStepAgainstPoint } from "./tools.js";
import { startCountdown } from "./timer.js";
import { searchCategory, searchCategoryResilient, reverseGeocode, searchText, adminDivisionsAt } from "./places.js";
import { TENTACLES, findTentacle, MATCHING, findMatching, MEASURING, findMeasuring } from "./data/questions.js";
import { openSheet, closeSheet, toast, escapeHtml, promptText } from "./ui.js";
import { getPalette } from "./palette.js";

// Instead of tinting the still-possible area (which read too much like the drawn
// zones), we shade EVERYTHING outside it: the mask fills the excluded region dark,
// the active outline draws a crisp bright edge around the remaining play area.
// zIndex tiers keep the shading at the BOTTOM and every guide/outline ON TOP, so a
// division boundary or bisector is never buried under the 55%-dark mask.
// Colours come from the active palette (getPalette) so the colour-blind toggle
// (Phase 7) restyles everything live; only the neutral bits are constants here.
const MASK_BASE = { strokeOpacity: 0, clickable: false, zIndex: 1 };
const ACTIVE_BASE = { fillOpacity: 0, strokeOpacity: 0.95, strokeWeight: 3, clickable: false, zIndex: 2 };

// A large-but-LOCAL rectangle around `area`, minus `area` → the region to shade
// (everything but the play area), with `area` as a hole. Must NOT use a near-global
// rectangle: Google Maps can't disambiguate the fill direction of a polygon that
// spans most of the globe and ends up filling the small hole instead of the outside
// (the play area went dark). A rectangle padded generously around the area's bbox —
// but well short of hemispheric scale — renders the hole correctly while still
// covering any realistic pan/zoom around a game. Padding scales with the area size
// and is clamped to stay local; corners are clamped to valid lat/lng.
function maskOutside(area) {
  const turf = window.turf;
  if (!turf || !area) return null;
  try {
    const bb = turf.bbox(turf.feature(area)); // [minX,minY,maxX,maxY]
    const span = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
    const pad = Math.min(40, Math.max(8, span * 3)); // ~880 km min, never near-global
    const minX = Math.max(-179.9, bb[0] - pad), maxX = Math.min(179.9, bb[2] + pad);
    const minY = Math.max(-85, bb[1] - pad), maxY = Math.min(85, bb[3] + pad);
    const rect = turf.polygon([[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]);
    const diff = turf.difference(turf.featureCollection([rect, turf.feature(area)]));
    return diff ? diff.geometry : null;
  } catch (e) { console.warn("mask failed", e); return null; }
}
// Neutral style for the live line-drawing preview (Matching ▸ nearest-line). The
// committed guides restyle per-palette/per-step in _renderGuides.
const LINE_GUIDE = { strokeColor: "#38bdf8", strokeOpacity: 0.95, strokeWeight: 3, zIndex: 5 };

export class Layers {
  constructor(map, { boundaries } = {}) {
    this.map = map;
    this.boundaries = boundaries || null; // for the admin-division tracing helper (DDS)
    this.overlays = [];
    this.redoStack = [];
    this._pick = null;
  }

  init() {
    store.subscribe(() => this.render());
    // Live-restyle every overlay when the colour palette toggles (Phase 7),
    // without re-fetching anything.
    window.addEventListener("jltg:palette", () => this.render());
    this.render();
  }

  // ---- History operations ----
  addStep(tool, inputs, answer) {
    const step = createStep({ tool, inputs, answer, enabled: true });
    store.update((g) => g.history.push(step));
    this.redoStack = [];
    this._afterAdd(step);
    return step;
  }

  // Post-add hooks (Phase 11), both opt-in via Settings and non-blocking:
  //  • computed-truth check — warn (never override) if the manual answer would
  //    eliminate the hider's known point,
  //  • soft question timer — start a countdown once a question is asked.
  _afterAdd(step) {
    const g = store.getCurrent();
    const st = g?.settings || {};
    if (st.truthCheck) {
      const pt = g?.hiderLock?.point;
      if (pt && checkStepAgainstPoint(step, g.gameArea, pt) === "conflict") {
        // Delay so this lands AFTER the flow's "question added" toast.
        setTimeout(() => toast("⚠ This answer removes the hider's location — double-check it.", 5000), 450);
      }
    }
    if (st.questionTimer > 0) startCountdown(st.questionTimer, { onEnd: () => toast("⏱ Question time's up.") });
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
    // Top-level guard (Phase 8): a malformed Turf geometry must never leave the map
    // blank or throw uncaught. On failure we show a recoverable banner instead.
    try {
      this._render();
    } catch (e) {
      console.error("Layer render failed:", e);
      this._showRenderError("Couldn’t draw the map layers — try disabling the most recent question (Questions ▸ uncheck it).");
    }
  }

  _render() {
    const g = store.getCurrent();
    this._clear();
    if (!g) return;
    const pal = getPalette();

    // 1) Shading FIRST (bottom layer). Spotlight the still-possible area: shade
    // everything OUTSIDE it and outline its edge. As questions eliminate regions
    // the active area shrinks and the mask grows. With no questions yet, active ===
    // the game area, so this also signals the play area from the start.
    if (g.gameArea) {
      const active = computeActiveArea(g.gameArea, g.history);
      const mask = maskOutside(active || g.gameArea);
      if (mask) {
        for (const group of geojsonToPathGroups(mask)) {
          this.overlays.push(new google.maps.Polygon({ ...MASK_BASE, ...pal.mask, paths: group, map: this.map }));
        }
      }
      if (active) {
        for (const group of geojsonToPathGroups(active)) {
          this.overlays.push(new google.maps.Polygon({ ...ACTIVE_BASE, strokeColor: pal.active, paths: group, map: this.map }));
        }
      }
    }

    // 2) Per-question reference guides ON TOP of the shading (circles / lines /
    // outlines), so division boundaries and bisectors are never hidden by the mask.
    // Each enabled step draws in the next palette colour so two open questions of
    // the same tool (e.g. two Tentacles) are visually distinguishable (Phase 7).
    // A single failing step is contained so it can't blank every other guide.
    let idx = 0;
    let failed = 0;
    for (const s of g.history) {
      if (!s.enabled) continue;
      const color = pal.steps[idx % pal.steps.length];
      idx++;
      try {
        const { guides } = computeElimination(s, g.gameArea);
        this._renderGuides(guides, s, color);
      } catch (e) {
        failed++;
        console.error(`Guide render failed for step ${s.id} (${s.tool}); skipping it.`, e);
      }
    }
    if (failed) this._showRenderError(`${failed} question${failed === 1 ? "" : "s"} failed to render — try disabling ${failed === 1 ? "it" : "them"} in Questions.`);
    else this._hideRenderError();
  }

  // A dismissible, recoverable error banner (Phase 8). Reused across renders — one
  // banner, latest message wins; auto-hidden on the next clean render.
  _showRenderError(msg) {
    let bar = document.getElementById("layer-error");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "layer-error";
      bar.className = "err-banner";
      bar.innerHTML = `<span class="err-msg"></span><button class="err-x" aria-label="Dismiss">✕</button>`;
      bar.querySelector(".err-x").addEventListener("click", () => bar.remove());
      document.body.appendChild(bar);
    }
    bar.querySelector(".err-msg").textContent = msg;
  }
  _hideRenderError() {
    document.getElementById("layer-error")?.remove();
  }

  // guides: computed reference shapes. step: the owning history step (for editable
  // anchors). color: this step's cycle colour (Phase 7 per-step differentiation).
  _renderGuides(guides, step, color) {
    const pal = getPalette();
    const primary = color || pal.guide;
    for (const gd of guides || []) {
      if (gd.type === "circle") {
        this.overlays.push(new google.maps.Circle({ strokeColor: primary, strokeOpacity: 0.9, strokeWeight: 2, fillOpacity: 0, zIndex: 5, center: gd.center, radius: gd.radius, map: this.map, clickable: false }));
        if (gd.editable && step) this._editAnchor(step, gd.editable, gd.center, primary);
      } else if (gd.type === "line") {
        this.overlays.push(new google.maps.Polyline({ strokeColor: primary, strokeOpacity: 0.95, strokeWeight: 3, zIndex: 5, path: [gd.from, gd.to], map: this.map, clickable: false }));
      } else if (gd.type === "point") {
        if (gd.editable && step) this._editAnchor(step, gd.editable, { lat: gd.lat, lng: gd.lng }, primary, gd.label);
        else this.overlays.push(new google.maps.Marker({ position: { lat: gd.lat, lng: gd.lng }, label: gd.label || "", map: this.map }));
      } else if (gd.type === "outline") {
        // A drawn division / region boundary (bold) reads clearly as the dividing
        // line; incidental Voronoi cell edges stay faint. Both sit above the mask.
        const style = gd.bold
          ? { strokeColor: primary, strokeOpacity: 0.95, strokeWeight: 3, zIndex: 6 }
          : { strokeColor: pal.faintOutline, strokeOpacity: 0.55, strokeWeight: 1, zIndex: 5 };
        this.overlays.push(new google.maps.Polygon({ paths: gd.ring, ...style, fillOpacity: 0, clickable: false, map: this.map }));
      } else if (gd.type === "polyline") {
        this.overlays.push(new google.maps.Polyline({ path: gd.coords, strokeColor: primary, strokeOpacity: 0.9, strokeWeight: 3, clickable: false, zIndex: 5, map: this.map }));
      }
    }
  }

  // A drag-to-reposition anchor for a placed point (Radar centre, Thermometer A/B).
  // Correcting a mis-tapped point no longer means restarting the tool (Phase 7):
  // dragging rewrites step.inputs[field], which recomputes + re-renders the region.
  // A drag that lands outside the play area is rejected and snapped back.
  _editAnchor(step, field, position, color, label) {
    const marker = new google.maps.Marker({
      position, map: this.map, draggable: true, zIndex: 7,
      title: "Drag to reposition",
      label: label ? { text: label, color: "#04252a", fontWeight: "700" } : undefined,
    });
    marker.addListener("dragend", (e) => {
      const p = { lat: e.latLng.lat(), lng: e.latLng.lng() };
      const area = store.getCurrent()?.gameArea;
      if (area && window.turf && !this._inArea(p, area)) {
        toast("Keep the point inside the play area.");
        this.render(); // snap the marker back to the stored position
        return;
      }
      store.update((g) => { const s = g.history.find((x) => x.id === step.id); if (s) s.inputs[field] = p; });
    });
    this.overlays.push(marker);
  }

  _clear() {
    this.overlays.forEach((o) => o.setMap(null));
    this.overlays = [];
  }

  // ---- Map point picking (shared by tool flows) ----
  // constrainToArea: reject taps outside the game area (seeker locations must be
  // inside the play zone). No-op when there's no game area or turf.
  pick(count, hintText, { constrainToArea = false } = {}) {
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
        const p = { lat: e.latLng.lat(), lng: e.latLng.lng() };
        if (constrainToArea) {
          const area = store.getCurrent()?.gameArea;
          if (area && window.turf && !this._inArea(p, area)) { toast("Tap inside the play area."); return; }
        }
        pts.push(p);
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

  // True if {lat,lng} falls inside the game-area polygon (used to keep manually
  // placed objects / seeker points within the play zone).
  _inArea(p, area) {
    try {
      const turf = window.turf;
      return turf.booleanPointInPolygon(turf.point([p.lng, p.lat]), turf.feature(area));
    } catch (_) { return true; } // never block on a geometry error
  }

  // Keep only candidate features inside the play area — the hider is in the zone,
  // so places they could never be nearest to shouldn't distort the partition. No
  // effect without an area / turf.
  _inAreaFeatures(feats, area) {
    if (!area || !window.turf) return feats;
    return feats.filter((f) => this._inArea(f, area));
  }

  // A searchable radio list of candidate features. No cap on how many are shown
  // (long lists scroll); a filter box narrows by name when there are many. Values
  // are ORIGINAL indices so a selection maps back to features[] despite filtering.
  _featureListHTML(name, feats) {
    const items = feats.map((f, i) =>
      `<label class="feat-item" data-name="${escapeHtml((f.name || "").toLowerCase())}">
         <input type="radio" name="${name}" value="${i}" ${i === 0 ? "checked" : ""}/> ${i + 1}. ${escapeHtml(f.name)}
       </label>`).join("");
    const search = feats.length > 8
      ? `<input class="field feat-search" data-search="${name}" placeholder="Search ${feats.length} results…" />`
      : "";
    return `${search}<div class="seg feat-list" data-list="${name}">${items}</div>`;
  }

  // Wire a _featureListHTML search box to show/hide items by name substring.
  _wireFeatureSearch(sheet, name) {
    const box = sheet.q(`[data-search="${name}"]`);
    if (!box) return;
    const items = sheet.qa(`[data-list="${name}"] .feat-item`);
    box.addEventListener("input", () => {
      const q = box.value.trim().toLowerCase();
      items.forEach((el) => { el.style.display = !q || el.dataset.name.includes(q) ? "" : "none"; });
    });
  }

  // ---- Unified POI candidate picker (shared by every POI question) --------
  // Given an initial candidate set (auto-found, possibly empty), let the seeker
  // TICK which ones count and ADD missing ones by tap or by name/address search.
  // Returns the final [{lat,lng,name}] (the ticked ∪ added) or null if cancelled.
  // Used by Matching-nearest, Tentacles and Measuring-points so the "choose some +
  // add your own (tap or search)" mechanism is identical across all POI cards.
  async _assembleCandidates(card, initialFeats, { minCount = 1, center = null, radius = 0 } = {}) {
    const g = store.getCurrent();
    const area = g?.gameArea;
    const feats = (initialFeats || []).map((f) => ({ lat: f.lat, lng: f.lng, name: f.name, on: true }));
    // Seed the reusable saved pins (Phase 9) as optional candidates — present but
    // UNticked, so the seeker can include any with one tap. In-area pins only.
    try {
      let pins = (await this.library?.getPins?.()) || [];
      if (area && window.turf) pins = pins.filter((p) => this._inArea(p, area));
      for (const p of pins) {
        const dup = feats.some((f) => Math.abs(f.lat - p.lat) < 1e-6 && Math.abs(f.lng - p.lng) < 1e-6);
        if (!dup) feats.push({ lat: p.lat, lng: p.lng, name: p.name, on: false });
      }
    } catch (_) { /* saved pins are optional */ }
    let markers = [];
    const drawMarkers = () => {
      markers.forEach((m) => m.setMap(null));
      markers = feats.map((f, i) => new google.maps.Marker({
        position: { lat: f.lat, lng: f.lng }, label: `${i + 1}`,
        opacity: f.on ? 1 : 0.35, map: this.map,
      }));
    };
    drawMarkers();

    return new Promise((resolve) => {
      let settled = false;
      const finish = (val) => { if (settled) return; settled = true; markers.forEach((m) => m.setMap(null)); resolve(val); };

      const render = () => {
        const rows = feats.map((f, i) =>
          `<label class="feat-item" data-name="${escapeHtml((f.name || "").toLowerCase())}">
             <input type="checkbox" data-idx="${i}" ${f.on ? "checked" : ""}/> ${i + 1}. ${escapeHtml(f.name)}
           </label>`).join("") || `<p class="muted">No candidates yet — add some by tap or search below.</p>`;
        const search = feats.length > 8
          ? `<input class="field feat-search" data-search="cand" placeholder="Filter ${feats.length}…" />` : "";
        const onCount = feats.filter((f) => f.on).length;
        const s = openSheet({
          title: `${card.label} — candidates`,
          mapInteractive: true,
          bodyHTML: `
            <p class="muted">Tick the ${escapeHtml(card.label.toLowerCase())}s that count and add any that are missing. These form the partition. You can pan the map behind this sheet.</p>
            ${search}
            <div class="seg feat-list" data-list="cand">${rows}</div>
            <div class="row">
              <button id="cand-tap" class="btn">✋ Add by tap</button>
              <button id="cand-search" class="btn">🔎 Add by search</button>
            </div>
            <div class="sheet-actions">
              <button id="cand-cancel" class="btn btn-ghost">Cancel</button>
              <button id="cand-done" class="btn btn-primary">Use selected (${onCount})</button>
            </div>`,
        });
        s.qa("[data-idx]").forEach((cb) => { cb.onchange = () => { feats[+cb.dataset.idx].on = cb.checked; drawMarkers(); }; });
        this._wireFeatureSearch(s, "cand");
        s.q("#cand-cancel").onclick = () => { s.close(); finish(null); };
        s.q("#cand-done").onclick = () => {
          const chosen = feats.filter((f) => f.on).map((f) => ({ lat: f.lat, lng: f.lng, name: f.name }));
          if (chosen.length < minCount) { toast(`Select at least ${minCount}.`); return; }
          s.close(); finish(chosen);
        };
        // Add by tap: close the sheet, drop a pin (constrained to the play area),
        // name it, then re-open the picker with the new candidate.
        s.q("#cand-tap").onclick = async () => {
          s.close();
          const pts = await this.pick(1, `Tap the ${card.label.toLowerCase()} location.`, area ? { constrainToArea: true } : {});
          if (pts) {
            const name = await promptText({ title: `Name this ${card.label.toLowerCase()}`, label: "Name", value: `${card.label} ${feats.length + 1}`, cta: "Add", mapInteractive: true });
            feats.push({ lat: pts[0].lat, lng: pts[0].lng, name: name || `${card.label} ${feats.length + 1}`, on: true });
            drawMarkers();
          }
          render();
        };
        // Add by search: text-search a place/address, confirm which result(s) to add.
        s.q("#cand-search").onclick = async () => {
          const query = await promptText({ title: `Search for a ${card.label.toLowerCase()}`, label: "Place or address", value: "", cta: "Search", mapInteractive: true });
          if (query == null || !query.trim()) { render(); return; }
          let results = [];
          try { toast("Searching…"); results = await searchText(this.map, query.trim(), { location: center || undefined, radius }); }
          catch (e) { toast(e.message); render(); return; }
          if (!results.length) { toast("No matches — try a more specific name."); render(); return; }
          s.close();
          const added = await this._pickSearchResults(card, results, area, { center, radius });
          for (const a of added) feats.push({ lat: a.lat, lng: a.lng, name: a.name, on: true });
          drawMarkers();
          render();
        };
      };
      render();
    });
  }

  // Choose which text-search results to add as candidates. Resolves to the picked
  // [{lat,lng,name}] (possibly empty). Results outside the play area are allowed but
  // flagged, since a seeker may deliberately add a just-outside landmark.
  _pickSearchResults(card, results, area, { center = null, radius = 0 } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      // Distance to the seeker centre (when given) → flag + default-uncheck anything
      // beyond the card's range, so "within range of me" is the default.
      const distOf = (r) => (center && window.turf)
        ? window.turf.distance([center.lng, center.lat], [r.lng, r.lat], { units: "meters" }) : null;
      const rows = results.map((r, i) => {
        const outside = area && window.turf && !this._inArea(r, area);
        const d = distOf(r);
        const outOfRange = !!(radius && d != null && d > radius);
        // Default-check in-range results (or the first, when no range is given).
        const checkedDefault = (radius && d != null) ? d <= radius : i === 0;
        return `<label class="feat-item">
            <input type="checkbox" value="${i}" ${checkedDefault ? "checked" : ""}/> ${escapeHtml(r.name)}
            ${outOfRange ? '<span class="muted"> · out of range</span>' : outside ? '<span class="muted"> · outside area</span>' : ""}
            ${r.address ? `<br/><span class="muted small">${escapeHtml(r.address)}</span>` : ""}
          </label>`;
      }).join("");
      const s = openSheet({
        title: `Add — “${escapeHtml(card.label)}”`,
        mapInteractive: true,
        bodyHTML: `
          <p class="muted">Tick the result(s) to add as candidates.${radius ? " Out-of-range results are unticked by default." : ""}</p>
          <div class="seg feat-list">${rows}</div>
          <div class="sheet-actions">
            <button id="sr-cancel" class="btn btn-ghost">Back</button>
            <button id="sr-add" class="btn btn-primary">Add selected</button>
          </div>`,
        onClose: () => done([]),
      });
      s.q("#sr-cancel").onclick = () => { s.close(); done([]); };
      s.q("#sr-add").onclick = () => {
        const chosen = s.qa('input[type="checkbox"]').filter((c) => c.checked)
          .map((c) => results[parseInt(c.value, 10)]).map((r) => ({ lat: r.lat, lng: r.lng, name: r.name }));
        done(chosen); s.close();
      };
    });
  }

  // ---- Panel ----
  openPanel() {
    const g = store.getCurrent();
    const canRedo = this.redoStack.length > 0;
    // Live computed-truth flag (Phase 11): mark any enabled step whose eliminated
    // region contains the hider's known point (opt-in + a point must be set).
    const truthOn = g.settings?.truthCheck && g.hiderLock?.point;
    const rows = g.history.length
      ? g.history.map((s) => {
          const conflict = truthOn && s.enabled && checkStepAgainstPoint(s, g.gameArea, g.hiderLock.point) === "conflict";
          const warn = conflict ? `<span class="li-warn" title="This answer removes the hider's location">⚠</span> ` : "";
          return `
          <li>
            <label class="li-toggle">
              <input type="checkbox" data-toggle="${s.id}" ${s.enabled ? "checked" : ""} />
              <span class="li-name ${s.enabled ? "" : "off"}">${warn}${escapeHtml(s.title || describeStep(s))}</span>
            </label>
            <span class="li-actions">
              <button class="btn btn-ghost btn-sm" data-rename="${s.id}">✏️</button>
              <button class="btn btn-ghost btn-sm" data-del="${s.id}">🗑</button>
            </span>
          </li>`;
        }).join("")
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
          <button id="t-admin" class="btn">🗺 Admin check</button>
        </div>
        <div class="row">
          <button id="t-undo" class="btn">↶ Undo</button>
          <button id="t-redo" class="btn" ${canRedo ? "" : "disabled"}>↷ Redo</button>
        </div>
        ${g.settings?.questionTimer > 0 ? `<div class="row"><button id="t-timer" class="btn">⏱ Start ${Math.round(g.settings.questionTimer / 60)}-min timer</button></div>` : ""}
        <h3 class="sub">Questions</h3>
        <ul class="list">${rows}</ul>`,
    });

    if (g.settings?.questionTimer > 0) s.q("#t-timer").onclick = () => { startCountdown(g.settings.questionTimer, { onEnd: () => toast("⏱ Question time's up.") }); s.close(); };
    s.q("#t-radar").onclick = () => this.startRadar();
    s.q("#t-thermo").onclick = () => this.startThermometer();
    s.q("#t-match").onclick = () => this.startMatching();
    s.q("#t-tent").onclick = () => this.startTentacles();
    s.q("#t-measure").onclick = () => this.startMeasuring();
    s.q("#t-admin").onclick = () => this.startAdminCheck();
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

  // ---- Admin-division comparison (Phase 9) ----
  // A diagnostic, not an elimination: tap two points, reverse-geocode both, and
  // compare their administrative divisions level by level (neighbourhood → city →
  // county → state → country), marking each ✓ same / ✗ different / – unknown. Helps
  // seekers reason about an admin-division question. (The admin1–4 Matching cards
  // remain the way to actually eliminate a region.) Reference: cniehaus's checker.
  async startAdminCheck() {
    const pts = await this.pick(2, "Tap two points to compare their admin divisions.");
    if (!pts || pts.length < 2) return this.openPanel();
    const markers = pts.map((p, i) => new google.maps.Marker({ position: p, label: `${i + 1}`, map: this.map }));
    toast("Looking up divisions…");
    let A, B;
    try {
      [A, B] = await Promise.all([reverseGeocode(pts[0]), reverseGeocode(pts[1])]);
    } catch (e) {
      markers.forEach((m) => m.setMap(null));
      toast(e.message);
      return this.openPanel();
    }
    const levels = [
      ["Neighbourhood", "neighbourhood"],
      ["City / town", "city"],
      ["County / 2nd admin", "county"],
      ["State / 1st admin", "state"],
      ["Country", "country"],
    ];
    const rows = levels.map(([label, key]) => {
      const a = A[key], b = B[key];
      const mark = a && b ? (a === b ? "✓" : "✗") : "–";
      const cls = mark === "✓" ? "adm-same" : mark === "✗" ? "adm-diff" : "adm-unk";
      return `<tr>
        <td>${escapeHtml(label)}</td>
        <td>${escapeHtml(a || "—")}</td>
        <td>${escapeHtml(b || "—")}</td>
        <td class="${cls}">${mark}</td>
      </tr>`;
    }).join("");
    const s = openSheet({
      title: "Admin divisions",
      bodyHTML: `
        <p class="muted">Comparing point ➊ and point ➋. ✓ same · ✗ different · – unknown.</p>
        <div class="adm-wrap">
          <table class="adm-table">
            <thead><tr><th>Level</th><th>➊</th><th>➋</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="sheet-actions"><button id="adm-close" class="btn btn-primary">Done</button></div>`,
      onClose: () => markers.forEach((m) => m.setMap(null)),
    });
    s.q("#adm-close").onclick = () => s.close();
  }

  // Custom categories saved in the reusable library (Phase 9), as an <optgroup> of
  // <option value="custom:ID">. Empty string when none / no library. Async: the
  // caller awaits this before building the tool sheet.
  async _customCategoryOptions() {
    try {
      const cats = (await this.library?.getCategories?.()) || [];
      if (!cats.length) return { html: "", cats };
      const opts = cats.map((c) => `<option value="custom:${c.id}">${escapeHtml(c.label)}</option>`).join("");
      return { html: `<optgroup label="Custom">${opts}</optgroup>`, cats };
    } catch (_) { return { html: "", cats: [] }; }
  }

  // ---- Radar flow ----
  async startRadar() {
    // Every question shades WITHIN the play area, so without one there's nothing to
    // shade (the map would look unchanged). Require a zone first, like the other
    // tools — a 🌍 Region boundary is only a reference, not a play area.
    if (!store.getCurrent()?.gameArea) return toast("Add a zone first (Zones ▸ Draw) to define the play area.");
    const pts = await this.pick(1, "Tap the radar centre inside the play area.", { constrainToArea: true });
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
    if (!store.getCurrent()?.gameArea) return toast("Add a zone first (Zones ▸ Draw) to define the play area.");
    const pts = await this.pick(2, "Tap point A then B, inside the play area.", { constrainToArea: true });
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
    const { html: customOpts, cats } = await this._customCategoryOptions();
    const s = openSheet({
      title: "Matching",
      bodyHTML: `
        <p class="muted">You (the seeker) ask “is your nearest ___ the same as mine?” Enter <em>your</em> answer, then tap Yes (hider matches) or No (hider differs) — the app keeps or removes your region accordingly.</p>
        <label class="fieldlbl">Question</label>
        <select id="mt-cat" class="field">${opts}${customOpts}</select>
        <div class="sheet-actions">
          <button id="mt-cancel" class="btn btn-ghost">Cancel</button>
          <button id="mt-next" class="btn btn-primary">Next</button>
        </div>
        <p id="mt-status" class="muted"></p>`,
    });
    s.q("#mt-cancel").onclick = () => s.close();
    s.q("#mt-next").onclick = async () => {
      const val = s.q("#mt-cat").value;
      // A custom library category behaves like a nearest-of-category card.
      if (val.startsWith("custom:")) {
        const c = cats.find((x) => `custom:${x.id}` === val);
        if (!c) return toast("That category is unavailable.");
        return this._matchNearest({ id: val, label: c.label, mode: "nearest", type: c.type || undefined, keyword: c.keyword || undefined }, s);
      }
      const card = findMatching(val);
      if (card.mode === "nearest") return this._matchNearest(card, s);
      if (card.mode === "nameLength") return this._matchNameLength(card, s);
      if (card.mode === "nearestLine") { s.close(); return this._matchNearestLine(card); }
      if (card.mode === "region") { s.close(); return this._matchRegion(card); }
    };
  }

  // Nearest-of-a-category → keep the hider's Voronoi cell. The candidate set can be
  // found automatically (Places) or placed by the seeker (their own objects).
  async _matchNearest(card, s) {
    s.q("#mt-status").innerHTML = `
      <label class="fieldlbl">Candidate ${escapeHtml(card.label.toLowerCase())}s</label>
      <div class="row">
        <button id="mt-auto" class="btn btn-primary">🔍 Auto-find nearby</button>
        <button id="mt-manual" class="btn">✋ Place my own</button>
      </div>
      <span id="mt-msg" class="muted"></span>`;
    const setMsg = (t) => { const m = s.q("#mt-msg"); if (m) m.textContent = t; };
    s.q("#mt-auto").onclick = async () => {
      const g = store.getCurrent();
      const { center, radius } = this._searchParams(g.gameArea);
      setMsg("Searching…");
      let feats = [], source = "google";
      try {
        ({ feats, source } = await searchCategoryResilient(this.map, { center, radius, type: card.type, keyword: card.keyword, gameArea: g.gameArea }));
      } catch (e) { setMsg(e.message); return; }
      feats = this._inAreaFeatures(feats, g.gameArea);
      s.close();
      if (source === "overpass") toast("Using OpenStreetMap (Places was unavailable).");
      // Refine the auto-found set: tick which count, add missing by tap/search
      // (search biased to the area centre).
      const chosen = await this._assembleCandidates(card, feats, { minCount: 2, center });
      if (!chosen) return this.openPanel();
      this._matchNearestSelect(card, chosen);
    };
    s.q("#mt-manual").onclick = async () => {
      s.close();
      const chosen = await this._assembleCandidates(card, [], { minCount: 2 });
      if (!chosen) return this.openPanel();
      this._matchNearestSelect(card, chosen);
    };
  }

  // Selection + same/different sheet shared by auto and manual candidate sets.
  _matchNearestSelect(card, feats) {
    const temp = feats.map((f, i) => new google.maps.Marker({ position: { lat: f.lat, lng: f.lng }, label: `${i + 1}`, map: this.map }));
    const s2 = openSheet({
      title: card.label,
      bodyHTML: `
        <p class="muted">Which is <strong>your</strong> nearest ${escapeHtml(card.label.toLowerCase())}?</p>
        ${this._featureListHTML("mt-feat", feats)}
        <label class="fieldlbl">Did the hider answer the same?</label>
        <div class="seg" role="radiogroup">
          <label><input type="radio" name="mt-match" value="yes" checked/> Yes — same (keep this region)</label>
          <label><input type="radio" name="mt-match" value="no"/> No — different (remove this region)</label>
        </div>
        <div class="sheet-actions"><button id="mt-cancel2" class="btn btn-ghost">Cancel</button><button id="mt-add" class="btn btn-primary">Add question</button></div>`,
      onClose: () => temp.forEach((m) => m.setMap(null)),
    });
    this._wireFeatureSearch(s2, "mt-feat");
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
    feats = this._inAreaFeatures(feats, g.gameArea).map((f) => ({ ...f, len: nameLen(f.name) }));
    if (feats.length < 2) { s.q("#mt-status").textContent = `Found ${feats.length} stations in the play area. Need at least 2.`; return; }
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
  async _matchRegion(card) {
    // Admin-division cards get a tracing helper: highlight the OFFICIAL boundary of
    // the division you're in (via DDS) so you can trace it. Cleared once drawing ends.
    const isAdmin = ["admin1", "admin2", "admin3", "admin4"].includes(card.id);
    let cleanup = () => {};
    if (isAdmin) cleanup = await this._adminTracePrompt();
    try {
      await this._regionSideSheet(
        { drawHint: `Outline the ${card.label} you (the seeker) are in`, title: card.label, intro: `Draw the ${card.label.toLowerCase()} you're in, then answer whether the hider is in the same one.` },
        (ring, inside) => {
          this.addStep("matching", { mode: "region", category: card.id, categoryLabel: card.label, ring }, { inside });
          toast("Matching question added.");
        },
      );
    } finally { cleanup(); }
  }

  // Reference point for "the division you're in": the play-area centroid (the
  // seeker is in their zone), falling back to the current map centre.
  _adminRefPoint() {
    try {
      const g = store.getCurrent();
      if (g?.gameArea && window.turf) {
        const c = window.turf.centroid(window.turf.feature(g.gameArea));
        return { lat: c.geometry.coordinates[1], lng: c.geometry.coordinates[0] };
      }
    } catch (_) { /* fall through */ }
    const c = this.map.getCenter();
    return { lat: c.lat(), lng: c.lng() };
  }

  // Pre-draw helper: toggle official admin-division boundaries (DDS) to trace over.
  // Resolves to a cleanup() that removes any highlights (called once drawing ends).
  async _adminTracePrompt() {
    const b = this.boundaries;
    if (!b) return () => {};
    if (!b.ddsAvailable) {
      toast("Add a vector Map ID with boundary layers (Settings) to trace real division outlines.");
      return () => {};
    }
    let levels = [];
    try { levels = await adminDivisionsAt(this._adminRefPoint()); }
    catch (_) { /* geocode failed — just skip the helper */ }
    if (!levels.length) return () => {};

    const active = new Set(); // "feature|placeId"
    const clearAll = () => {
      for (const key of active) { const [f, p] = key.split("|"); b.setAdminHighlight(f, p, false); }
      active.clear();
    };
    return new Promise((resolve) => {
      let settled = false;
      const done = (fn) => { if (!settled) { settled = true; resolve(fn); } };
      const rows = levels.map((lv) =>
        `<label class="feat-item"><input type="checkbox" data-f="${lv.feature}" data-p="${escapeHtml(lv.placeId)}"/> ${escapeHtml(lv.label)} — ${escapeHtml(lv.name)}</label>`).join("");
      const s = openSheet({
        title: "Trace division boundaries",
        bodyHTML: `
          <p class="muted">Toggle the official boundary of the division you're in to trace over it, then start drawing. Needs boundary FeatureLayers enabled on your Map ID — if a toggle shows nothing on the map, they aren't enabled.</p>
          <div class="seg feat-list">${rows}</div>
          <div class="sheet-actions">
            <button id="at-skip" class="btn btn-ghost">Skip</button>
            <button id="at-draw" class="btn btn-primary">Start drawing</button>
          </div>`,
        onClose: () => done(clearAll),
      });
      s.qa("input[data-f]").forEach((cb) => {
        cb.onchange = () => {
          const f = cb.dataset.f, p = cb.dataset.p, key = `${f}|${p}`;
          if (cb.checked) {
            if (b.setAdminHighlight(f, p, true)) active.add(key);
            else { cb.checked = false; toast("That boundary layer isn't enabled on your Map ID."); }
          } else { b.setAdminHighlight(f, p, false); active.delete(key); }
        };
      });
      s.q("#at-skip").onclick = () => { clearAll(); s.close(); done(() => {}); };
      s.q("#at-draw").onclick = () => { s.close(); done(clearAll); };
    });
  }

  // ---- Tentacles (fixed-radius "which are you closest to?") ----
  async startTentacles() {
    const g = store.getCurrent();
    if (!g?.gameArea) return toast("Add zones first to define the search area.");
    const rTxt = (r) => (r >= 1000 ? `${r / 1000} km` : `${r} m`);
    const opts = TENTACLES.map((c) =>
      `<option value="${c.id}">${escapeHtml(c.label)} · ${rTxt(c.radius)}${c.approx ? ` (${escapeHtml(c.approx)})` : ""}</option>`
    ).join("");
    const { cats } = await this._customCategoryOptions();
    const customOptsR = cats.length
      ? `<optgroup label="Custom">${cats.map((c) => `<option value="custom:${c.id}">${escapeHtml(c.label)} · ${rTxt(c.radius || 2000)}</option>`).join("")}</optgroup>`
      : "";
    // Resolve a select value (built-in id or custom:ID) to a tentacle card.
    const resolveCat = (val) => val.startsWith("custom:")
      ? (() => { const c = cats.find((x) => `custom:${x.id}` === val); return c ? { id: val, label: c.label, type: c.type || undefined, keyword: c.keyword || undefined, radius: c.radius || 2000 } : null; })()
      : findTentacle(val);
    const s = openSheet({
      title: "Tentacles",
      bodyHTML: `
        <p class="muted">A fixed-radius “which of these are you closest to?” card. Pick one, then either auto-find the places (tap a search centre) or place your own on the map.</p>
        <label class="fieldlbl">Card</label>
        <select id="tt-cat" class="field">${opts}${customOptsR}</select>
        <div class="sheet-actions">
          <button id="tt-cancel" class="btn btn-ghost">Cancel</button>
          <button id="tt-manual" class="btn">✋ Place my own</button>
          <button id="tt-find" class="btn btn-primary">🔍 Auto-find</button>
        </div>
        <p id="tt-status" class="muted"></p>`,
    });
    s.q("#tt-cancel").onclick = () => s.close();
    s.q("#tt-manual").onclick = async () => {
      const cat = resolveCat(s.q("#tt-cat").value);
      if (!cat) return toast("That category is unavailable.");
      s.close();
      // Seeker names the exact places they care about; radius/Voronoi logic is the
      // same. At least one is enough (single candidate ⇒ area ∩ its radius circle).
      const feats = await this._assembleCandidates(cat, [], { minCount: 1 });
      if (!feats || !feats.length) return this.openPanel();
      this._chooseTentacle(cat, feats, null);
    };
    s.q("#tt-find").onclick = async () => {
      const cat = resolveCat(s.q("#tt-cat").value);
      if (!cat) return toast("That category is unavailable.");
      s.close();
      // Ask the seeker to place a search centre near the play area, then look for the
      // category around it. The centre only AIMS the Places search; the candidate SET
      // is every place whose radius circle can reach the play area. This matters for
      // correctness: the hider reveals which candidate they are closest to, so a
      // nearer place missing from the list would force a wrong "closest" and wrongly
      // eliminate the true hiding region.
      const pts = await this.pick(1, `Tap a ${cat.label.toLowerCase()} search centre inside the play area.`, { constrainToArea: true });
      if (!pts) return this.openPanel();
      const center = pts[0];
      toast("Searching…");
      const turf = window.turf;
      const bb = turf.bbox(turf.feature(g.gameArea));
      const corners = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]];
      const maxD = Math.max(...corners.map((c) => turf.distance([center.lng, center.lat], c, { units: "meters" })));
      const searchRadius = Math.min(50000, maxD + cat.radius); // cover the whole area + tentacle reach
      let feats = [], source = "google";
      try {
        // Overpass fallback bbox is padded by the tentacle radius so places just
        // outside the play area (but within reach) are still found.
        ({ feats, source } = await searchCategoryResilient(this.map, { center, radius: searchRadius, type: cat.type, keyword: cat.keyword, gameArea: g.gameArea, padMeters: cat.radius }));
      } catch (e) {
        toast(e.message);
        return this.openPanel();
      }
      if (source === "overpass") toast("Using OpenStreetMap (Places was unavailable).");
      // Keep only places whose radius circle can actually reach the play area (no
      // cap — long lists are searchable in the chooser).
      feats = feats.filter((f) => distancePointToArea(f, g.gameArea) <= cat.radius);
      if (!feats.length) toast(`No ${cat.label.toLowerCase()} within ${rTxt(cat.radius)} of the play area — add your own below.`);
      // Refine: tick which count, add missing by tap/search (add-your-own included).
      const chosen = await this._assembleCandidates(cat, feats, { minCount: 1 });
      if (!chosen || !chosen.length) return this.openPanel();
      this._chooseTentacle(cat, chosen, center);
    };
  }

  _chooseTentacle(cat, features, center) {
    const rTxt = cat.radius >= 1000 ? `${cat.radius / 1000} km` : `${cat.radius} m`;
    const temp = features.map((f, i) =>
      new google.maps.Marker({ position: { lat: f.lat, lng: f.lng }, label: `${i + 1}`, map: this.map })
    );
    // Show the placed search centre for context (cleared with the sheet). No range
    // circle: the tentacle radius is measured from each place / the hider, not this
    // centre, so a circle here would misrepresent which places qualify.
    if (center) {
      temp.push(new google.maps.Marker({ position: center, label: { text: "C", color: "#04252a", fontWeight: "700" }, title: "Search centre", map: this.map }));
    }
    const s = openSheet({
      title: "Tentacles",
      bodyHTML: `
        <p class="muted">${escapeHtml(cat.label)} within ${rTxt}. Which is the hider closest to?</p>
        ${this._featureListHTML("tt-feat", features)}
        <div class="seg"><label><input type="radio" name="tt-feat" value="none"/> None within ${rTxt} (hider is outside all)</label></div>
        <div class="sheet-actions">
          <button id="tt-cancel2" class="btn btn-ghost">Cancel</button>
          <button id="tt-add" class="btn btn-primary">Add question</button>
        </div>`,
      onClose: () => temp.forEach((m) => m.setMap(null)),
    });
    this._wireFeatureSearch(s, "tt-feat");
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
    const { html: customOpts, cats } = await this._customCategoryOptions();
    const s = openSheet({
      title: "Measuring",
      bodyHTML: `
        <p class="muted">You (the seeker) ask “are you closer to / farther from the nearest ___ than me?” Enter <em>your</em> distance, then tap the hider's answer.</p>
        <label class="fieldlbl">Question</label>
        <select id="m-cat" class="field">${opts}${customOpts}</select>
        <div class="sheet-actions">
          <button id="m-cancel" class="btn btn-ghost">Cancel</button>
          <button id="m-next" class="btn btn-primary">Next</button>
        </div>
        <p id="m-status" class="muted"></p>`,
    });
    s.q("#m-cancel").onclick = () => s.close();
    s.q("#m-next").onclick = async () => {
      const val = s.q("#m-cat").value;
      // A custom library category behaves like a nearest-of-category (points) card.
      if (val.startsWith("custom:")) {
        const c = cats.find((x) => `custom:${x.id}` === val);
        if (!c) return toast("That category is unavailable.");
        return this._measurePoints({ id: val, label: c.label, ref: "points", type: c.type || undefined, keyword: c.keyword || undefined }, s);
      }
      const card = findMeasuring(val);
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
    s.q("#m-status").innerHTML = `
      <label class="fieldlbl">Reference ${escapeHtml(card.label.toLowerCase())}s</label>
      <div class="row">
        <button id="m-auto" class="btn btn-primary">🔍 Auto-find nearby</button>
        <button id="m-manual" class="btn">✋ Place my own</button>
      </div>
      <span id="m-msg" class="muted"></span>`;
    const setMsg = (t) => { const m = s.q("#m-msg"); if (m) m.textContent = t; };
    s.q("#m-auto").onclick = async () => {
      const g = store.getCurrent();
      const { center, radius } = this._searchParams(g.gameArea);
      setMsg("Searching…");
      let feats = [], source = "google";
      try {
        ({ feats, source } = await searchCategoryResilient(this.map, { center, radius, type: card.type, keyword: card.keyword, gameArea: g.gameArea }));
      } catch (e) { setMsg(e.message); return; }
      feats = this._inAreaFeatures(feats, g.gameArea);
      s.close();
      if (source === "overpass") toast("Using OpenStreetMap (Places was unavailable).");
      // Refine: tick which reference points count, add missing by tap/search
      // (search biased to the area centre).
      const chosen = await this._assembleCandidates(card, feats, { minCount: 1, center });
      if (!chosen || !chosen.length) return this.openPanel();
      this._pointsDistanceSheet(card, chosen);
    };
    // Manual: the seeker marks exactly which instances count, avoiding the over-
    // or under-counting that auto-Places can cause.
    s.q("#m-manual").onclick = async () => {
      s.close();
      const chosen = await this._assembleCandidates(card, [], { minCount: 1 });
      if (!chosen || !chosen.length) return this.openPanel();
      this._pointsDistanceSheet(card, chosen);
    };
  }

  // Build the reference geometry from chosen points (one ⇒ Point, several ⇒
  // MultiPoint, buffered the same) and open the distance sheet. Shared by the
  // auto and manual Measuring-points paths after candidate assembly.
  _pointsDistanceSheet(card, feats) {
    this._distanceSheet(card, {
      refType: "points", refLabel: card.label,
      refGeometry: feats.length === 1
        ? { type: "Point", coordinates: [feats[0].lng, feats[0].lat] }
        : { type: "MultiPoint", coordinates: feats.map((f) => [f.lng, f.lat]) },
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
