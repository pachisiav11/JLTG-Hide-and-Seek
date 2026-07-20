// Elimination layers: manages the history of elimination steps, renders each
// enabled step's shaded region + the remaining active area, and provides
// backtracking (undo / redo / per-layer toggle). Also hosts the tool input flows
// for Radar and Thermometer (guide §5.1, §5.2, §6.2).
import * as store from "./store.js";
import { createStep } from "./model.js";
import { geojsonToPathGroups, featuresNearArea, ringSelfIntersections, ringCrossesAntimeridian } from "./geo.js";
import { computeElimination, computeActiveArea, describeStep, EMPTY_AREA } from "./tools.js";
import { countStationsInEliminated } from "./stations.js";
import { startCountdown } from "./timer.js";
import { searchCategoryResilient, reverseGeocode, searchText, adminDivisionsAt, matchNames } from "./places.js";
import { TENTACLES, findTentacle, MATCHING, findMatching, MEASURING, findMeasuring } from "./data/questions.js";
import { openSheet, closeSheet, toast, escapeHtml, pluralLabel, promptText, distanceFieldHTML, readDistanceMeters, repairRadioSelection } from "./ui.js";
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
function paddedRect(area) {
  const turf = window.turf;
  const bb = turf.bbox(turf.feature(area)); // [minX,minY,maxX,maxY]
  const span = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
  const pad = Math.min(40, Math.max(8, span * 3)); // ~880 km min, never near-global
  const minX = Math.max(-179.9, bb[0] - pad), maxX = Math.min(179.9, bb[2] + pad);
  const minY = Math.max(-85, bb[1] - pad), maxY = Math.min(85, bb[3] + pad);
  return turf.polygon([[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]);
}

function maskOutside(area) {
  const turf = window.turf;
  if (!turf || !area) return null;
  try {
    const diff = turf.difference(turf.featureCollection([paddedRect(area), turf.feature(area)]));
    return diff ? diff.geometry : null;
  } catch (e) { console.warn("mask failed", e); return null; }
}

// The same rectangle with NO hole — shade everything. Used when the active area is empty,
// where masking "outside the active area" would otherwise fall back to the game area and
// draw a fully-eliminated board as if it were untouched.
function maskEverything(area) {
  const turf = window.turf;
  if (!turf || !area) return null;
  try { return paddedRect(area).geometry; }
  catch (e) { console.warn("mask failed", e); return null; }
}
// Neutral style for the live line-drawing preview (Matching ▸ nearest-line). The
// committed guides restyle per-palette/per-step in _renderGuides.
const LINE_GUIDE = { strokeColor: "#38bdf8", strokeOpacity: 0.95, strokeWeight: 3, zIndex: 5 };

// Distinct colours for the Metro Lines candidate list (F1), so the radio list and the map
// agree at a glance. Deliberately NOT OSM's `colour` tag: two lines can share a colour, and
// the whole point here is telling candidates apart. Not palette-driven either — these are
// identity, not semantics, so the colour-blind toggle has nothing to restyle.
const TENTACLE_LINE_COLOURS = ["#f472b6", "#38bdf8", "#facc15", "#4ade80", "#c084fc", "#fb923c", "#22d3ee", "#f87171"];

// Above this many sourced lines, a Matching "which are you nearest to" question stops being
// answerable and _sourcedMatchLines refuses, pointing at the 🚄 rail filter.
//
// Not a rendering limit — the list scrolls fine. It is the point past which BOTH players can
// no longer hold the same set in their heads and name the same line, which is what the card
// requires. Set to the colour count because that is also where the map stops telling
// candidates apart: past eight, two lines repeat a colour and the list and the map disagree.
const MATCH_LINE_LIMIT = TENTACLE_LINE_COLOURS.length;

// Google's nearbySearch radius ceiling. Not ours to raise — it is the API's hard maximum.
const GOOGLE_MAX_RADIUS_M = 50000;

// Surface a card's approximation AT THE POINT OF USE, not just as a parenthetical in the
// category dropdown.
//
// For Metro Lines this is now the FALLBACK story, not the card's story: F1 sources real OSM
// line geometry and partitions by line, and only drops back to a station Voronoi when there
// is no proxy configured, Overpass is down, or the board has no metro. So this warning fires
// only on that path — which is exactly when the seeker needs it, because the question has
// quietly reverted to the approximate one:
//
//   Lines A and B run parallel a few hundred metres apart. The hider stands beside line A,
//   midway between its stations. The nearest STATION is on line B, so the station-Voronoi
//   puts them in B's cell. The hider truthfully answers "closest to line A" and the seeker
//   either cannot record it, or records it and eliminates the hider's real location.
function approxWarning(cat) {
  if (cat.id !== "subway_station") {
    return `<p class="warn-note">⚠ This card is approximated ${escapeHtml(cat.approx)} — the partition may not match the answer exactly.</p>`;
  }
  return `<p class="warn-note">⚠ Couldn't load real line geometry, so this fell back to partitioning by nearest <strong>station</strong>, not nearest <strong>line</strong>. Where two lines run closer together than their stations are spaced, the hider's nearest line may not be the nearest station's line. If their answer looks inconsistent with the map, trust them, not this.</p>`;
}

// Google could not search the whole board. Say so: the partition is being built from
// whatever fell inside a 50 km disc, and the seeker cannot tell that from a complete answer.
function clampWarning(radius, wanted) {
  const km = (m) => Math.round(m / 1000);
  return `Google can only search ${km(radius)} km around the board's centre — your area needs ${km(wanted)} km, so places near the edges may be missing.`;
}

// Why OpenStreetMap supplied the candidates. For dense cards (stations and friends) OSM is
// now the intended PRIMARY source, so the old blanket "Places was unavailable" would be a
// plain lie — Places was never asked.
function sourceToast(reason) {
  if (reason === "primary") return "Using OpenStreetMap — the complete list for this area.";
  if (reason === "uncapped") return "Using OpenStreetMap — Google capped at 60 results.";
  if (reason === "thin") return "Using OpenStreetMap — Google returned very few results.";
  return "Using OpenStreetMap (Places was unavailable).";
}

export class Layers {
  constructor(map, { boundaries, lines } = {}) {
    this.map = map;
    this.boundaries = boundaries || null; // for the admin-division tracing helper (DDS)
    this.lines = lines || null; // the 🚄 rail panel, so a refused line card can open it (P4)
    this.overlays = [];
    this._pick = null;
    this.failedSteps = new Set(); // step ids whose geometry failed on the last render
  }

  init() {
    // subscribe() invokes the callback synchronously when a current game exists, and
    // app.js awaits store.init() (which always sets one) before constructing us — so this
    // IS the first render. An explicit this.render() here made every overlay get built,
    // torn down and rebuilt at boot: on a country-scale area that is a duplicated
    // turf.difference plus a full Google Polygon rebuild, for nothing.
    store.subscribe(() => this.render());
    // Live-restyle every overlay when the colour palette toggles (Phase 7),
    // without re-fetching anything.
    window.addEventListener("jltg:palette", () => this.render());
  }

  // ---- History operations ----
  // The redo stack lives on the game record (see model.js), so it survives a reload.
  addStep(tool, inputs, answer) {
    const step = createStep({ tool, inputs, answer, enabled: true });
    store.update((g) => { g.history.push(step); g.redoStack = []; });
    this._afterAdd(step);
    return step;
  }

  // Post-add hook (Phase 11), opt-in via Settings and non-blocking:
  //  • soft question timer — start a countdown once a question is asked.
  _afterAdd(step) {
    const g = store.getCurrent();
    const st = g?.settings || {};
    if (st.questionTimer > 0) startCountdown(st.questionTimer, { onEnd: () => toast("⏱ Question time's up.") });
  }
  toggle(id) {
    store.update((g) => {
      const s = g.history.find((x) => x.id === id);
      if (s) s.enabled = !s.enabled;
      g.redoStack = []; // a manual toggle makes the pending redo meaningless
    });
  }
  remove(id) {
    store.update((g) => {
      g.history = g.history.filter((x) => x.id !== id);
      g.redoStack = []; // ...and would otherwise point at a step that no longer exists
    });
  }
  undo() {
    const g = store.getCurrent();
    const enabled = (g?.history || []).filter((s) => s.enabled);
    if (!enabled.length) return toast("Nothing to undo.");
    const last = enabled[enabled.length - 1];
    store.update((gg) => {
      const s = gg.history.find((x) => x.id === last.id);
      if (s) s.enabled = false;
      (gg.redoStack ||= []).push(last.id);
    });
  }
  redo() {
    const g = store.getCurrent();
    if (!g?.redoStack?.length) return toast("Nothing to redo.");
    let redone = null;
    store.update((gg) => {
      // Skip ids whose step has since vanished rather than silently doing nothing.
      while (gg.redoStack.length && !redone) {
        const id = gg.redoStack.pop();
        const s = gg.history.find((x) => x.id === id);
        if (s) { s.enabled = true; redone = s; }
      }
    });
    if (!redone) toast("Nothing to redo.");
  }
  canRedo() {
    return (store.getCurrent()?.redoStack?.length || 0) > 0;
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
    const notices = [];
    // Populated before the mask is built, because computeActiveArea reports steps whose
    // elimination could not be folded in — those are invisible otherwise.
    this.failedSteps = new Set();
    let dropped = 0;
    if (g.gameArea) {
      const active = computeActiveArea(g.gameArea, g.history, (id, reason) => {
        if (reason === "union") { this.failedSteps.add(id); dropped++; }
      });
      const isEmpty = active === EMPTY_AREA;
      // Shade the whole board when nothing survives. Falling back to `g.gameArea` here
      // would draw a fully-eliminated game pixel-identically to a fresh one — the one
      // state where the seeker most needs to be told something is wrong.
      const mask = isEmpty ? maskEverything(g.gameArea) : maskOutside(active || g.gameArea);
      if (mask) {
        for (const group of geojsonToPathGroups(mask)) {
          this.overlays.push(new google.maps.Polygon({ ...MASK_BASE, ...pal.mask, paths: group, map: this.map }));
        }
      }
      if (active && !isEmpty) {
        for (const group of geojsonToPathGroups(active)) {
          this.overlays.push(new google.maps.Polygon({ ...ACTIVE_BASE, strokeColor: pal.active, paths: group, map: this.map }));
        }
      }
      if (isEmpty) {
        notices.push("Every question combined rules out the whole area — check the most recent answer.");
      }
    }

    // 2) Per-question reference guides ON TOP of the shading (circles / lines /
    // outlines), so division boundaries and bisectors are never hidden by the mask.
    // Each enabled step draws in the next palette colour so two open questions of
    // the same tool (e.g. two Tentacles) are visually distinguishable (Phase 7).
    // A single failing step is contained so it can't blank every other guide.
    let idx = 0;
    let failed = 0;
    // Guarded on g.gameArea like the mask above — it was NOT, which is how removing every
    // zone orphaned the guides: removeZone recomputes gameArea to null but never touches
    // g.history, so radar circles and bisectors kept drawing on a map with no shading
    // context, describing an area that no longer exists.
    //
    // Adds to this.failedSteps (already seeded above by any union failures): a failing
    // question stays checked and enabled, so without marking it in the Questions panel the
    // banner tells the seeker something broke but not what to disable.
    const liveSteps = g.gameArea ? g.history.filter((s) => s.enabled) : [];
    for (const s of liveSteps) {
      const color = pal.steps[idx % pal.steps.length];
      idx++;
      try {
        const { guides } = computeElimination(s, g.gameArea);
        this._renderGuides(guides, s, color);
      } catch (e) {
        failed++;
        this.failedSteps.add(s.id);
        console.error(`Guide render failed for step ${s.id} (${s.tool}); skipping it.`, e);
      }
    }
    // Questions outliving their zones is a real state (removing the last zone), not an
    // error — so say what happened rather than leaving a blank map with no explanation.
    if (!g.gameArea) {
      const orphaned = g.history.filter((s) => s.enabled).length;
      if (orphaned) {
        notices.push(`${orphaned} question${orphaned === 1 ? "" : "s"} ${orphaned === 1 ? "is" : "are"} saved but can't be shown without a play area — add a zone (Zones ▸ Draw) to see ${orphaned === 1 ? "it" : "them"} again.`);
      }
    }
    if (failed) notices.push(`${failed} question${failed === 1 ? "" : "s"} failed to render — try disabling ${failed === 1 ? "it" : "them"} in Questions.`);
    // A dropped elimination is worse than a failed guide: the map looks healthy but is
    // missing a region a question ruled out, so say so explicitly rather than lumping it in.
    if (dropped) notices.push(`${dropped} question${dropped === 1 ? "'s" : "s'"} elimination could not be combined and ${dropped === 1 ? "is" : "are"} missing from the shading — the map may show area that is already ruled out.`);
    // One banner for both conditions: an unconditional _hideRenderError() here would
    // clear the empty-area notice raised above.
    if (notices.length) this._showRenderError(notices.join(" "));
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
        // A committed radar centre is LOCKED (its position is only adjustable during
        // setup) and LABELLED "◎" so it reads as the radar centre, not a stray pin.
        if (gd.editable && step) this._lockedAnchor(gd.center, "◎", "Radar centre");
      } else if (gd.type === "line") {
        this.overlays.push(new google.maps.Polyline({ strokeColor: primary, strokeOpacity: 0.95, strokeWeight: 3, zIndex: 5, path: [gd.from, gd.to], map: this.map, clickable: false }));
      } else if (gd.type === "point") {
        // Committed thermometer A/B anchors: labelled + locked (see radar centre).
        if (gd.editable && step) this._lockedAnchor({ lat: gd.lat, lng: gd.lng }, gd.label, `Point ${gd.label || ""}`.trim());
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

  // A committed, LOCKED anchor marker (Radar centre, Thermometer A/B). The centre is
  // positioned only DURING question setup (see _setupAnchor); once the question is
  // committed the position is fixed, so this marker is non-draggable and just labels
  // the point (so it isn't mistaken for a location/hider pin).
  _lockedAnchor(position, label, title) {
    this.overlays.push(new google.maps.Marker({
      position, map: this.map, zIndex: 7, clickable: false,
      title: title || "Locked point",
      label: label ? { text: String(label), color: "#04252a", fontWeight: "700" } : undefined,
    }));
  }

  // A live geometry preview shown DURING setup (B1). Renders the elimination the
  // step would produce right now, plus a live readout of size and "would eliminate X
  // of Y stations" when the game has a confirmed station set. Committing promotes
  // this into a real fold step; cancelling discards the preview entirely.
  //
  // Design decision: uses `computeElimination` on a virtual step (same code that
  // renders a committed step), so the preview and the committed result are always
  // pixel-identical — the whole "guess and see if it eliminated anything you meant"
  // failure mode B1 exists to remove is that a committed step showed different area
  // than a mental estimate. Anything short of running the real math re-opens that gap.
  //
  // Overlays live in `state.overlays`, cleared on every `render()` and on `remove()`.
  _draftPreview({ readoutEl } = {}) {
    const state = { overlays: [], lastStep: null };
    const pal = getPalette();
    const PREVIEW_FILL = { strokeColor: pal.mask.fillColor || "#020a0c", strokeOpacity: 0.75, strokeWeight: 1.5, fillColor: pal.mask.fillColor || "#020a0c", fillOpacity: 0.28, clickable: false, zIndex: 6 };
    const clear = () => { state.overlays.forEach((o) => o.setMap(null)); state.overlays = []; };
    const countStationsInside = (geom) => {
      const g = store.getCurrent();
      return countStationsInEliminated(geom, g?.stations?.list || []);
    };
    const writeReadout = (size, count) => {
      if (!readoutEl) return;
      const g = store.getCurrent();
      const stations = g?.stations?.list || [];
      const confirmed = g?.stations?.confirmedAt;
      const stationText = !stations.length
        ? `<span class="muted">No station set — see Stations in the ☰ menu for a live counter.</span>`
        : !confirmed
        ? `<span class="muted">Station set is a draft (see Stations ▸ Lock in for a stable counter).</span>`
        : count === null
        ? `<span class="muted">Station count unavailable.</span>`
        : `<strong>${count.inside}</strong> of ${count.total} active station${count.total === 1 ? "" : "s"} would be eliminated`;
      readoutEl.innerHTML = `${size} · ${stationText}`;
    };
    const render = (step, { sizeLabel }) => {
      clear();
      const g = store.getCurrent();
      if (!g?.gameArea) { writeReadout(sizeLabel || "", null); return; }
      let eliminated = null;
      try {
        const out = computeElimination(step, g.gameArea);
        eliminated = out?.eliminated || null;
      } catch (e) { console.warn("draft preview failed", e); }
      if (eliminated) {
        for (const group of geojsonToPathGroups(eliminated)) {
          state.overlays.push(new google.maps.Polygon({ ...PREVIEW_FILL, paths: group, map: this.map }));
        }
      }
      state.lastStep = step;
      writeReadout(sizeLabel || "", countStationsInside(eliminated));
    };
    const remove = () => { clear(); state.lastStep = null; };
    return { render, remove };
  }

  // A DRAGGABLE preview anchor shown while a question is being set up, so the seeker
  // can fine-tune the point before committing. Drags outside the play area are
  // rejected and snapped back. Caller reads getPos() at commit and calls remove() on
  // every exit path (cancel / close / add). After commit the point is locked.
  _setupAnchor(position, label, { onMove = null } = {}) {
    const state = { pos: { ...position } };
    const marker = new google.maps.Marker({
      position, map: this.map, draggable: true, zIndex: 8,
      title: "Drag to adjust — locks when you add the question",
      label: label ? { text: String(label), color: "#04252a", fontWeight: "700" } : undefined,
    });
    marker.addListener("dragend", (e) => {
      const p = { lat: e.latLng.lat(), lng: e.latLng.lng() };
      const area = store.getCurrent()?.gameArea;
      if (area && window.turf && !this._inArea(p, area)) {
        toast("Keep the point inside the play area.");
        marker.setPosition(state.pos); // snap back to the last valid position
        return;
      }
      state.pos = p;
      // Notify B1's preview so the eliminated shape and the readout follow the drag.
      // Only fires on a VALID move (an out-of-area drag was already rejected above).
      try { onMove?.(p); } catch (e) { console.warn("anchor onMove failed", e); }
    });
    return { getPos: () => ({ ...state.pos }), remove: () => marker.setMap(null) };
  }

  _clear() {
    this.overlays.forEach((o) => o.setMap(null));
    this.overlays = [];
  }

  // Take ownership of the map click for the life of a draw / pick flow, and hand it back.
  //
  // Google fires EVERY click listener on a tap, and MapFeatures keeps one for measure mode.
  // With measure left on, a single tap into an outline both added a vertex and dropped a
  // measure pin — two features silently fighting over the same gesture, neither able to see
  // the other. Broadcast rather than a direct call: layers has no handle on MapFeatures, and
  // giving it one would couple the tool flows to a sibling they otherwise never touch.
  _claimMapClicks() {
    window.dispatchEvent(new CustomEvent("jltg:mapclaim"));
    let released = false;
    return () => { if (!released) { released = true; window.dispatchEvent(new CustomEvent("jltg:maprelease")); } };
  }

  // ---- Map point picking (shared by tool flows) ----
  // constrainToArea: reject taps outside the game area (seeker locations must be
  // inside the play zone). No-op when there's no game area or turf.
  pick(count, hintText, { constrainToArea = false } = {}) {
    return new Promise((resolve) => {
      closeSheet();
      const release = this._claimMapClicks();
      const pts = [];
      const markers = [];
      const bar = document.createElement("div");
      bar.className = "draw-bar";
      bar.innerHTML = `<span class="draw-count">${hintText}</span><button class="btn btn-ghost btn-sm" data-cancel>Cancel</button>`;
      document.body.appendChild(bar);

      const cleanup = () => {
        release();
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
  // `ring: true` closes the shape and refuses a self-crossing one (D1). Callers drawing a
  // LINE leave it off: a line has no implicit closing edge, and a trace that crosses itself
  // still buffers correctly.
  _drawShape(minPts, hint, { ring = false } = {}) {
    return new Promise((resolve) => {
      closeSheet();
      const release = this._claimMapClicks();
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
        release();
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
        // Refuse rather than auto-fix: a bowtie is genuinely ambiguous (two triangles? a
        // square with two taps swapped?), so "fixing" it would be a guess that silently
        // changes which area gets eliminated — the failure this guard exists to prevent.
        // The draw bar stays open and the points are kept, so Undo is one tap away.
        if (ring && ringSelfIntersections(pts.map((p) => [p.lat, p.lng]))) {
          toast("This outline crosses itself, so it has no clear inside — undo the last point or two and close it without crossing.");
          return;
        }
        // D2: same refusal as a zone, for the same measured reason — an outline across the
        // ±180° line reads as wrapping the long way round the planet, silently.
        if (ring && ringCrossesAntimeridian(pts.map((p) => [p.lat, p.lng]))) {
          toast("An outline can't cross the ±180° line yet — draw it on one side of the date line.");
          return;
        }
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

  // Bound the candidate set without dropping legitimate partition seeds (see
  // featuresNearArea in geo.js — it lives there because it is pure geometry, and so it can
  // be tested without a DOM).
  _nearAreaFeatures(feats, area) {
    return featuresNearArea(feats, area);
  }

  // A searchable radio list of candidate features. No cap on how many are shown
  // (long lists scroll); a filter box narrows by name when there are many. Values
  // are ORIGINAL indices so a selection maps back to features[] despite filtering.
  //
  // NOTHING starts checked. Pre-checking index 0 left the downstream "require an explicit
  // pick" guards unreachable on the common path — open the sheet, scan the list, press Add
  // without touching the filter, and candidate #1 was committed as an answer the seeker
  // never gave. Only `repairRadioSelection` (filter typing) ever cleared it, so the guard
  // bound in the one case the user HAD engaged with the list. This also makes the point
  // picker agree with `_chooseTentacleLines`, which never had a default.
  _featureListHTML(name, feats) {
    const items = feats.map((f, i) =>
      `<label class="feat-item" data-name="${escapeHtml((f.name || "").toLowerCase())}">
         <input type="radio" name="${name}" value="${i}"/> ${i + 1}. ${escapeHtml(f.name)}
       </label>`).join("");
    const search = feats.length > 8
      ? `<input class="field feat-search" data-search="${name}" placeholder="Search ${feats.length} results…" />`
      : "";
    return `${search}<div class="seg feat-list" data-list="${name}">${items}</div>`;
  }

  // Wire a _featureListHTML search box to show/hide items by name substring.
  //
  // Filtering used to set `display` only and never touch `checked`. So typing "Waterloo",
  // seeing only Waterloo, and hitting Add recorded whatever was still checked BEHIND the
  // filter — index 0 by default, a different and now-invisible station. The wrong question
  // was committed silently, and describeStep then reported the wrong name.
  _wireFeatureSearch(sheet, name) {
    const box = sheet.q(`[data-search="${name}"]`);
    if (!box) return;
    const items = sheet.qa(`[data-list="${name}"] .feat-item`);
    box.addEventListener("input", () => {
      const q = box.value.trim().toLowerCase();
      const visible = [];
      items.forEach((el) => {
        const show = !q || el.dataset.name.includes(q);
        el.style.display = show ? "" : "none";
        if (show) visible.push(el);
      });

      // Only radio lists (pick exactly one) need selection repair. The candidate picker is
      // a CHECKBOX list — "tick which ones count" — where ticks are deliberate and a hidden
      // tick is still a real choice. Touching those would be its own silent bug.
      const inputs = items.map((el) => el.querySelector("input"));
      if (!inputs.some((i) => i && i.type === "radio")) return;

      const visibleIdx = [];
      inputs.forEach((inp, i) => { if (inp && items[i].style.display !== "none") visibleIdx.push(i); });
      const checkedIdx = inputs.findIndex((inp) => inp && inp.checked);
      // An option outside the filtered list (Tentacles' "None — a miss") must survive.
      const externalChecked = sheet.qa(`input[name="${name}"]`)
        .some((r) => r.checked && !r.closest(".feat-item"));

      const want = repairRadioSelection({
        visibleIdx,
        checkedIdx: checkedIdx === -1 ? null : checkedIdx,
        externalChecked,
      });
      if (!externalChecked) {
        inputs.forEach((inp, i) => { if (inp) inp.checked = i === want; });
      }
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
            <p class="muted">Tick the ${escapeHtml(pluralLabel(card.label).toLowerCase())} that count and add any that are missing. These form the partition. You can pan the map behind this sheet.</p>
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
        // Find or add by name. Checks the LOCAL list first (B7): after B1–B3 the complete
        // set for the play area is already in memory, so the place the seeker means is
        // usually right here. Going straight to Google both wasted a round trip and, worse,
        // ADDED A DUPLICATE of a station already in the list — seeding the Voronoi twice at
        // one spot. Google is the fall-through for a genuine miss.
        s.q("#cand-search").onclick = async () => {
          const query = await promptText({ title: `Find a ${card.label.toLowerCase()}`, label: "Name (or address)", value: "", cta: "Find", mapInteractive: true });
          if (query == null || !query.trim()) { render(); return; }

          const local = matchNames(feats.map((f) => f.name), query.trim());
          if (local.length) {
            // Tick the matches rather than re-adding them, and untick the rest so the
            // seeker sees exactly what they asked for.
            const best = feats[local[0]];
            for (const i of local) feats[i].on = true;
            drawMarkers();
            toast(local.length === 1
              ? `Found “${best.name}” — ticked.`
              : `Found ${local.length} matches for “${query.trim()}” — ticked. Best: “${best.name}”.`);
            render();
            return;
          }

          let results = [];
          try { toast("Not in the list — searching…"); results = await searchText(this.map, query.trim(), { location: center || undefined, radius }); }
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
    const canRedo = this.canRedo();
    const rows = g.history.length
      ? g.history.map((s) => {
          const broke = this.failedSteps?.has(s.id);
          return `
          <li>
            <label class="li-toggle">
              <input type="checkbox" data-toggle="${s.id}" ${s.enabled ? "checked" : ""} />
              <span class="li-name ${s.enabled ? "" : "off"}">${escapeHtml(s.title || describeStep(s))}${broke ? ` <span class="li-failed" title="This question could not be computed — its geometry degenerated. It is contributing no shading.">⚠ failed</span>` : ""}</span>
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
    // Labelled in GOOGLE's terms, with no ordinals. These rows come from reverse geocoding, and
    // "County / 2nd admin" / "State / 1st admin" asserted an equivalence to the game's division
    // ordinals that is not true: the game's ordinals are COUNTRY_DIVISION_LEVELS, a measured
    // per-country OSM admin_level, and they disagree with Google's numbering in Japan, Ireland,
    // Singapore and Germany among others. A diagnostic that helps a seeker reason about an
    // admin-division question must not answer a different question from the cards.
    const levels = [
      ["Neighbourhood", "neighbourhood"],
      ["City / town", "city"],
      ["County / district", "county"],
      ["State / province", "state"],
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
        <p class="muted">These are Google's administrative names, not the game's division ordinals — the 1st/2nd Division cards use a measured per-country boundary level that can sit at a different tier. Use this to reason, not to answer.</p>
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
    const units = store.getCurrent()?.settings?.units || "metric";
    // Live preview (B1): the eliminated shape and a "would eliminate X of Y" readout
    // update as the seeker drags the centre, edits the radius, or flips the side —
    // so the size is a visible decision rather than a guess that only reveals its
    // impact after commit.
    let preview = null; // rebound once the sheet renders and the readout element exists
    const anchor = this._setupAnchor(pts[0], "◎", { onMove: () => refresh() });
    const s = openSheet({
      title: "Radar",
      mapInteractive: true,
      bodyHTML: `
        <p class="muted">“Are you within this distance of the point?” Drag the ◎ centre to adjust it before adding — it locks once the question is added.</p>
        <label class="fieldlbl">Radius</label>
        ${distanceFieldHTML("r-radius", 1000, units)}
        <div class="seg" role="radiogroup" aria-label="Answer">
          <label><input type="radio" name="r-side" value="in" checked /> Yes — inside</label>
          <label><input type="radio" name="r-side" value="out" /> No — outside</label>
        </div>
        <p id="r-readout" class="draft-readout muted"></p>
        <div class="sheet-actions">
          <button id="r-cancel" class="btn btn-ghost">Cancel</button>
          <button id="r-add" class="btn btn-primary">Add question</button>
        </div>`,
      onClose: () => { anchor.remove(); preview?.remove(); }, // cancel, ✕, add all call close
    });
    preview = this._draftPreview({ readoutEl: s.q("#r-readout") });
    const refresh = () => {
      if (!preview) return;
      const radius = readDistanceMeters(s, "r-radius", units);
      const side = s.qa('input[name="r-side"]').find((r) => r.checked)?.value || "in";
      if (!Number.isFinite(radius) || radius <= 0) {
        // Keep the readout visible with a status message; drop only the polygon.
        preview.render({ id: "draft", tool: "radar", enabled: true, inputs: { center: anchor.getPos(), radius: 0 }, answer: { side } }, { sizeLabel: "Enter a radius…" });
        return;
      }
      const step = { id: "draft", tool: "radar", enabled: true, inputs: { center: anchor.getPos(), radius }, answer: { side } };
      const sizeLabel = units === "imperial"
        ? `${(radius / 1609.344).toFixed(radius >= 1609 ? 2 : 3)} mi`
        : radius >= 1000 ? `${(radius / 1000).toFixed(2)} km` : `${Math.round(radius)} m`;
      preview.render(step, { sizeLabel });
    };
    // Draw the initial preview immediately so the "1000 m" default has visible impact.
    refresh();
    s.q("#r-radius").addEventListener("input", refresh);
    for (const el of s.qa('input[name="r-side"]')) el.addEventListener("change", refresh);
    s.q("#r-cancel").onclick = () => s.close();
    s.q("#r-add").onclick = () => {
      // Validate, never clamp. `Math.max(10, parseFloat(...) || 0)` turned "0", "-500" and
      // "abc" all into 10 while the "question added" toast fired as though the typed value
      // had been honoured — the question then used a radius the seeker never chose.
      const radius = readDistanceMeters(s, "r-radius", units); // metres, whatever was typed
      if (!Number.isFinite(radius)) return toast("Enter a radius as a number.");
      if (radius <= 0) return toast("Enter a radius greater than zero.");
      const side = s.qa('input[name="r-side"]').find((r) => r.checked)?.value || "in";
      this.addStep("radar", { center: anchor.getPos(), radius }, { side });
      s.close();
      toast("Radar question added.");
    };
  }

  // ---- Thermometer flow ----
  async startThermometer() {
    if (!store.getCurrent()?.gameArea) return toast("Add a zone first (Zones ▸ Draw) to define the play area.");
    const pts = await this.pick(2, "Tap point A then B, inside the play area.", { constrainToArea: true });
    if (!pts || pts.length < 2) return this.openPanel();
    const units = store.getCurrent()?.settings?.units || "metric";
    // Live preview (B1): the eliminated half and station count update as A/B drag or
    // the side flips. Unlike radar the thermometer has no radius field — its only
    // knobs are the endpoints and the answer, so both drive `refresh`.
    let preview = null;
    const anchorA = this._setupAnchor(pts[0], "A", { onMove: () => refresh() });
    const anchorB = this._setupAnchor(pts[1], "B", { onMove: () => refresh() });
    const s = openSheet({
      title: "Thermometer",
      mapInteractive: true,
      bodyHTML: `
        <p class="muted">Moving A → B, are you hotter (closer) or colder (farther)? Drag A or B to adjust before adding — they lock once the question is added.</p>
        <div class="seg" role="radiogroup" aria-label="Answer">
          <label><input type="radio" name="th-side" value="hotter" checked /> Hotter (closer to B)</label>
          <label><input type="radio" name="th-side" value="colder" /> Colder (closer to A)</label>
        </div>
        <p id="th-readout" class="draft-readout muted"></p>
        <div class="sheet-actions">
          <button id="th-cancel" class="btn btn-ghost">Cancel</button>
          <button id="th-add" class="btn btn-primary">Add question</button>
        </div>`,
      onClose: () => { anchorA.remove(); anchorB.remove(); preview?.remove(); },
    });
    preview = this._draftPreview({ readoutEl: s.q("#th-readout") });
    const refresh = () => {
      if (!preview) return;
      const side = s.qa('input[name="th-side"]').find((r) => r.checked)?.value || "hotter";
      const a = anchorA.getPos(), b = anchorB.getPos();
      const step = { id: "draft", tool: "thermometer", enabled: true, inputs: { a, b }, answer: { side } };
      // Straight-line A→B distance as the "size" — the question's scale, and what a
      // seeker adjusts by dragging.
      let sizeLabel = "";
      if (window.turf) {
        try {
          const km = window.turf.distance(window.turf.point([a.lng, a.lat]), window.turf.point([b.lng, b.lat]), { units: "kilometers" });
          sizeLabel = units === "imperial"
            ? `A→B ${(km * 0.621371).toFixed(km * 0.621371 >= 1 ? 2 : 3)} mi`
            : km >= 1 ? `A→B ${km.toFixed(2)} km` : `A→B ${Math.round(km * 1000)} m`;
        } catch (_) { sizeLabel = ""; }
      }
      preview.render(step, { sizeLabel });
    };
    refresh();
    for (const el of s.qa('input[name="th-side"]')) el.addEventListener("change", refresh);
    s.q("#th-cancel").onclick = () => s.close();
    s.q("#th-add").onclick = () => {
      const side = s.qa('input[name="th-side"]').find((r) => r.checked)?.value || "hotter";
      this.addStep("thermometer", { a: anchorA.getPos(), b: anchorB.getPos() }, { side });
      s.close();
      toast("Thermometer question added.");
    };
  }

  // ---- Matching / Tentacles (shared Voronoi flow) ----
  // Google's nearbySearch takes a radius around a POINT and hard-caps it at 50 km. On a
  // board with a >100 km diagonal that disc cannot span the play area, so POIs near the
  // edges are never found and the partition is computed from a subset — silently.
  //
  // For dense cards this is now moot: B2 sends those to Overpass, which takes the play
  // area's POLYGON and has no radius at all. It still binds for Google-first cards, so
  // `clamped` is reported and the caller warns rather than quietly under-searching.
  _searchParams(gameArea) {
    const turf = window.turf;
    const c = turf.centroid(turf.feature(gameArea)).geometry.coordinates; // [lng,lat]
    const bb = turf.bbox(turf.feature(gameArea));
    const diag = turf.distance([bb[0], bb[1]], [bb[2], bb[3]], { units: "meters" });
    const wanted = Math.max(500, (diag / 2) * 1.2);
    const radius = Math.min(GOOGLE_MAX_RADIUS_M, wanted);
    return { center: { lat: c[1], lng: c[0] }, radius, clamped: wanted > GOOGLE_MAX_RADIUS_M, wanted };
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
      <label class="fieldlbl">Candidate ${escapeHtml(pluralLabel(card.label).toLowerCase())}</label>
      <div class="row">
        <button id="mt-auto" class="btn btn-primary">🔍 Auto-find nearby</button>
        <button id="mt-manual" class="btn">✋ Place my own</button>
      </div>
      <span id="mt-msg" class="muted"></span>`;
    const setMsg = (t) => { const m = s.q("#mt-msg"); if (m) m.textContent = t; };
    s.q("#mt-auto").onclick = async () => {
      const g = store.getCurrent();
      const { center, radius, clamped, wanted } = this._searchParams(g.gameArea);
      setMsg("Searching…");
      let feats = [], source = "google", reason = "primary";
      try {
        ({ feats, source, reason } = await searchCategoryResilient(this.map, { center, radius, type: card.type, keyword: card.keyword, gameArea: g.gameArea }));
      } catch (e) { setMsg(e.message); return; }
      feats = this._nearAreaFeatures(feats, g.gameArea);
      s.close();
      if (source === "overpass") toast(sourceToast(reason));
      else if (clamped) toast(clampWarning(radius, wanted));
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
      // Require an explicit pick. Defaulting to "0" here was the second mouth of the same
      // bug: with the checked item filtered away, Add silently recorded a station the
      // seeker never chose and could not see.
      const picked = s2.qa('input[name="mt-feat"]').find((r) => r.checked);
      if (!picked) return toast("Choose which one is nearest to you first.");
      const featureIndex = parseInt(picked.value, 10);
      const keep = (s2.qa('input[name="mt-match"]').find((r) => r.checked)?.value ?? "yes") === "yes";
      this.addStep("matching", { mode: "nearest", category: card.id, categoryLabel: card.label, features: feats }, { featureIndex, keep });
      s2.close();
      toast("Matching question added.");
    };
  }

  // Nearest transit station grouped by name letter-count.
  async _matchNameLength(card, s) {
    const g = store.getCurrent();
    const { center, radius, clamped, wanted } = this._searchParams(g.gameArea);
    s.q("#mt-status").textContent = "Searching stations…";
    let feats = [], source = "google", reason = "primary";
    try {
      // Was searchCategory: capped at Google's 60 stations for the ENTIRE board with no OSM
      // fallback, so in any dense metro this partitioned from an arbitrary subset and BOTH
      // answers eliminated the wrong regions, with no sign anything had been truncated.
      ({ feats, source, reason } = await searchCategoryResilient(this.map, {
        center, radius, type: card.type, keyword: card.keyword, gameArea: g.gameArea,
      }));
    } catch (e) { s.q("#mt-status").textContent = e.message; return; }
    feats = this._nearAreaFeatures(feats, g.gameArea);
    s.close();
    if (source === "overpass") toast(sourceToast(reason));
      else if (clamped) toast(clampWarning(radius, wanted));

    // This was the only POI card that skipped the candidate picker, so a seeker could not
    // add the station they actually meant. Now it behaves like every other POI card.
    const chosen = await this._assembleCandidates(card, feats, { minCount: 2, center });
    if (!chosen) return this.openPanel();
    this._nameLengthSelect(card, chosen);
  }

  // Group the chosen stations by name length and ask for the seeker's own length.
  _nameLengthSelect(card, chosenFeats) {
    // Count letters in the station name only — drop parenthetical qualifiers
    // (e.g. "Shinjuku Station (South Exit)") that aren't part of the name players
    // compare, then collapse whitespace before counting.
    const nameLen = (n) => (((n || "").replace(/\s*\([^)]*\)/g, "").match(/\p{L}/gu)) || []).length;
    const feats = chosenFeats.map((f) => ({ ...f, len: nameLen(f.name) }));
    if (feats.length < 2) { toast(`Need at least 2 stations; got ${feats.length}.`); return this.openPanel(); }
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

  // Nearest of several lines/paths (Transit Line, Street or Path).
  //
  // §F4 was marked "superseded by G1", but only the TENTACLES half was rebuilt — this card was
  // still tracing transit by hand, which is the local-knowledge advantage §G1 exists to remove:
  // a Mumbai player draws the Western Line from memory, a visitor guesses, and the two boards
  // then disagree about real area. `linePaths` already normalises hand-drawn `coords` and
  // sourced `paths` into one partition, so the geometry side needed nothing new.
  //
  // Sourcing is offered where the card names a lineKind, hand-drawing everywhere else (Street
  // or Path has no sane OSM candidate set — a board has thousands of streets).
  async _matchNearestLine(card) {
    if (card.lineKind) {
      const how = await this._lineSourceSheet(card, { many: true });
      if (!how) return this.openPanel();
      // A sourced pick opens its own sheet and commits from there; null means it could not
      // (and has said why), so fall through to drawing rather than dead-ending.
      if (how === "auto" && (await this._sourcedMatchLines(card))) return;
    }
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
    // Two lines minimum, not one. A one-line "is your nearest line the same as mine?" has
    // exactly one truthful answer, and the partition degenerates: lineCells gives the single
    // line every cell, so it owns the whole board. "Same" then subtracts the board from
    // itself and eliminates NOTHING — the question is committed, enabled, listed, and
    // contributes no shading. "Different" eliminates the ENTIRE board, and the seeker is told
    // to re-check an answer that was correct. Neither throws, so neither is ever marked
    // failed. `_matchNearest` already enforces minCount: 2 for the same reason.
    //
    // The Tentacles line picker warns at <2 rather than refusing, and that is right there:
    // it has a radius, so one line still asks "are you within R of it" — a radar. Matching
    // has no radius, so one line asks nothing at all.
    if (lines.length < 2) {
      clearOverlays();
      toast(`A ${card.label.toLowerCase()} question needs at least two lines — with one, every answer means the same thing.`);
      return this.openPanel();
    }
    this._nearestLineSheet(card, lines, { onClose: clearOverlays });
  }

  // Sourced transit lines for a Matching nearestLine card. Returns true if it took over the
  // flow, false to fall back to hand-drawing — every false having SAID why first.
  //
  // The candidate set is the whole point and the whole difficulty. Measured on a 1,753 km²
  // Mumbai Metropolitan board (2026-07-18):
  //   kind "metro" -> 9 lines, all real, but MISSES Western/Central/Harbour — the suburban
  //                   locals Mumbai actually plays on, which are the answer to this card.
  //   kind "rail"  -> 44, containing those locals AND ~26 intercity services that merely pass
  //                   through (Rajdhani Express 12951, Vande Bharat 20705, Golden Temple Mail).
  // Both sets are `route=train` — Western Line and Rajdhani Express carry the SAME route tag —
  // so no mode filter can separate them, and they share physical track, so `lineCells` gives a
  // seed on those rails to both. A 44-line partition is not a harder question, it is an
  // unanswerable one: "nearest line" has no single truthful answer when an express shares the
  // Western Line's metals.
  //
  // So `rail` is the query and the board's OWN rail filter is the answer — the app already has
  // this concept (the 🚄 panel, `railFilter`, honoured inside candidateLines), it was simply
  // never load-bearing for a question before. What is added here is refusing to present a set
  // the filter has not made answerable, and pointing at the filter instead of guessing which
  // lines the players meant.
  async _sourcedMatchLines(card) {
    const g = store.getCurrent();
    if (!g?.gameArea) { toast("Draw a game area first."); return false; }
    toast(`Finding ${pluralLabel(card.label).toLowerCase()}…`);
    let sourced = [];
    try {
      const { candidateLines } = await import("./lines.js");
      // No radius: Matching asks about the whole board, not a reach from the seeker. The centre
      // only orders the list, and is deliberately NOT shown as a distance — the app does not
      // know where the seeker is standing, and printing "1.2 km away" would imply it does.
      const c = this.map.getCenter();
      const out = await candidateLines(card.lineKind, g.gameArea, { lat: c.lat(), lng: c.lng() }, Infinity, { game: g });
      sourced = out?.lines || [];
    } catch (e) {
      console.warn("matching line sourcing failed", e);
      toast(e.status === 400
        ? `${card.label} request rejected: ${e.message} — draw them instead.`
        : `Couldn't load ${pluralLabel(card.label).toLowerCase()} — draw them instead.`);
      return false;
    }
    if (sourced.length < 2) {
      toast(sourced.length
        ? `Only one ${card.label.toLowerCase()} is on this board, so the question can't distinguish — draw them instead.`
        : `No ${pluralLabel(card.label).toLowerCase()} found on this board — draw them instead.`);
      return false;
    }
    // The refusal above is B2's guard; this one is the candidate-set problem. Both players must
    // be answering about the SAME small set they can each name, and an unfiltered mainline
    // query is neither small nor nameable.
    // P4: measured on both default Mumbai boards, this is the path a new board ALWAYS takes —
    // 44 lines on MMR, 32 on the city board, against a limit of 8 — because `hiddenRoutes`
    // starts empty. So this refusal, not the card, is the common first experience, and telling
    // the player to go and find 🚄 themselves makes them pay the fetch again to find out
    // whether they picked few enough. Hand them the panel instead.
    //
    // Deliberately NOT solved by defaulting `hiddenRoutes` to hide `train`. Measured across two
    // captures of this same city it lands on opposite sides of the limit — the live MMR board
    // (35 train + 9 subway) keeps 9 and still refuses, an older capture (9 + 4) keeps 4 and
    // passes. A default whose correctness depends on the day the board was captured is not a
    // fix, and it would also decide for the players which lines are in play.
    if (sourced.length > MATCH_LINE_LIMIT) {
      const open = this.lines && await this._confirm(
        `${sourced.length} ${pluralLabel(card.label).toLowerCase()} on this board — too many to answer, because both players have to name the same line. Pick which lines are in play now?`);
      if (open) await this.lines.openPanel(g.gameArea);
      else toast(`Use 🚄 to pick which ${pluralLabel(card.label).toLowerCase()} are in play, then ask again.`);
      return false;
    }
    // Store geometry, not a reference to it — the partition must recompute identically for the
    // life of the game even if OSM is edited or the cache is cleared. Same shape the Tentacles
    // line picker commits, and `linePaths` reads `paths` and hand-drawn `coords` alike.
    const lines = sourced.map((l, i) => ({ id: `ln_${i}_${l.key}`, label: l.label, paths: l.paths }));
    const overlays = [];
    lines.forEach((l, i) => {
      const colour = TENTACLE_LINE_COLOURS[i % TENTACLE_LINE_COLOURS.length];
      for (const path of l.paths) {
        overlays.push(new google.maps.Polyline({
          path: path.map(([lat, lng]) => ({ lat, lng })),
          strokeColor: colour, strokeOpacity: 0.95, strokeWeight: 4, zIndex: 6, clickable: false, map: this.map,
        }));
      }
    });
    this._nearestLineSheet(card, lines, {
      sourced: true,
      onClose: () => overlays.forEach((o) => o.setMap(null)),
    });
    return true;
  }

  // The pick-a-line + did-they-match sheet, shared by the drawn and the sourced paths so the
  // two cannot drift apart on the guards.
  _nearestLineSheet(card, lines, { sourced = false, onClose } = {}) {
    // Nothing pre-checked: see _featureListHTML. A default here meant Add could commit the
    // first line as "the one you're nearest to" without the seeker ever choosing it.
    const list = lines.map((l) => `<label><input type="radio" name="ln" value="${l.id}"/> ${escapeHtml(l.label)}</label>`).join("");
    const s = openSheet({
      title: card.label,
      mapInteractive: sourced,
      bodyHTML: `
        <p class="muted">Which ${escapeHtml(card.label.toLowerCase())} are <strong>you</strong> nearest to?${sourced ? " Drawn on the map in the list's colours." : ""}</p>
        <div class="seg">${list}</div>
        <label class="fieldlbl">Did the hider answer the same one?</label>
        <div class="seg" role="radiogroup">
          <label><input type="radio" name="ln-match" value="yes" checked/> Yes — same (keep that region)</label>
          <label><input type="radio" name="ln-match" value="no"/> No — different (remove that region)</label>
        </div>
        <div class="sheet-actions"><button id="ln-cancel" class="btn btn-ghost">Cancel</button><button id="ln-add" class="btn btn-primary">Add question</button></div>`,
      onClose,
    });
    s.q("#ln-cancel").onclick = () => s.close();
    s.q("#ln-add").onclick = () => {
      const picked = s.qa('input[name="ln"]').find((r) => r.checked);
      if (!picked) return toast(`Choose which ${card.label.toLowerCase()} you're nearest to.`);
      const match = (s.qa('input[name="ln-match"]').find((r) => r.checked)?.value ?? "yes") === "yes";
      this.addStep("matching",
        { mode: "nearestLine", category: card.id, categoryLabel: card.label, lines, source: sourced ? "osm" : "drawn" },
        { lineId: picked.value, match });
      s.close();
      toast("Matching question added.");
    };
  }

  // Draw a [lat,lng] region and keep the hider's side. Shared by Matching (admin
  // divisions / landmass) and Measuring (sea level); onAdd(ring, inside) records
  // the tool-specific step.
  async _regionSideSheet({ drawHint, title, intro }, onAdd) {
    const pts = await this._drawShape(3, drawHint, { ring: true });
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
    if (isAdmin) cleanup = await this._adminTracePrompt(card);
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
  // What the GAME means by "the Nth division" on this board, as an HTML note (or "" when there
  // is nothing worth saying). Deliberately does NOT claim an equivalence between Google's
  // FeatureLayers and an OSM admin_level: no such mapping has been measured, and asserting one
  // would be the third contradicting definition rather than a resolution of the first two.
  // It states both facts and names which one the border card will draw.
  async _divisionDefinitionNote(card) {
    const ordinal = { admin1: 1, admin2: 2, admin3: 3, admin4: 4 }[card?.id];
    if (!ordinal) return "";
    const g = store.getCurrent();
    if (!g?.gameArea) return "";
    let agreed = null;
    try {
      const { resolveBoardDivisions } = await import("./lines.js");
      agreed = await resolveBoardDivisions(g.gameArea, { proxyBase: window.JLTG_CONFIG?.OVERPASS_PROXY_URL || null });
    } catch (_) { return ""; } // the note is a courtesy; a probe failure must not block tracing
    if (!agreed?.country) return "";
    const { country, levels } = agreed;
    const nth = ["1st", "2nd", "3rd", "4th"][ordinal - 1];
    // DDS only reaches Google's level-1, level-2 and locality — three layers for four cards.
    // A 4th-division card has never had a boundary to trace and never said so (R4).
    const beyondDds = ordinal > 3
      ? ` Google exposes no boundary layer this deep, so nothing below will outline a ${nth} division.`
      : "";
    // Only the 1st and 2nd division have a Measuring Border card (questions.js:145-146), so
    // only those two can be pointed at one. Naming a "3rd Admin. Division Border card" would
    // send a player looking for a card that does not exist.
    const hasBorderCard = ordinal <= 2;
    const measured = levels?.[ordinal - 1];
    if (measured == null) {
      const consequence = hasBorderCard
        ? `, so the ${escapeHtml(card.label)} Border card won't draw one here`
        : " and no automatic boundary at this depth";
      return `<p class="warn-note">⚠ ${escapeHtml(country)} has no measured ${nth} division in this game${consequence}. Whatever you trace below is your own boundary — make sure the hider is answering about the same one.${beyondDds}</p>`;
    }
    const draws = hasBorderCard
      ? ` — that is what the ${escapeHtml(card.label)} Border card draws.`
      : ".";
    return `<p class="warn-note">⚠ In ${escapeHtml(country)} this game's ${nth} division is OSM <code>admin_level ${measured}</code>${draws} The boundaries below are Google's and are not tagged by admin_level, so they may outline something different. Trace one only if it matches the division you and the hider agreed on.${beyondDds}</p>`;
  }

  async _adminTracePrompt(card) {
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

    // Reconcile Google's boundaries against the game's OWN definition of a division before the
    // player traces one. DDS can only offer Google's level-1/-2/locality; the border cards draw
    // COUNTRY_DIVISION_LEVELS, a measured per-country OSM admin_level. Where those disagree —
    // Japan, Ireland, Singapore, Germany among the measured set — tracing the highlighted
    // boundary answers a DIFFERENT question from the one the card will draw, and nothing said
    // so. This is a note, not a block: the helper is still useful when they agree, and a player
    // who knows the boundary is approximate can still trace it deliberately.
    //
    // Deliberately NOT awaited here. `_divisionDefinitionNote` fires 25 grid probes at
    // /overpass/divisions, which on a cold board measured 37.8 s — half a minute of a Hide &
    // Seek clock during which the sheet did not render at all. It is advisory: nothing the
    // player can do in this sheet depends on it, and it already returns "" on failure, so an
    // empty slot is a state the markup handles. Start it now, render immediately, inject on
    // arrival — and if the player has closed the sheet by then, drop it.
    const notePromise = this._divisionDefinitionNote(card).catch(() => "");

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
          <div id="at-note"></div>
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
      // The sheet is already interactive; fill the note slot whenever the probes finish.
      // `settled` is true once the sheet has closed, in which case there is nothing to fill.
      notePromise.then((note) => {
        if (settled || !note) return;
        const slot = s.q("#at-note");
        if (slot) slot.innerHTML = note; // built by _divisionDefinitionNote, already escaped
      });
    });
  }

  // ---- Tentacles (fixed-radius "which are you closest to?") ----
  async startTentacles() {
    const g = store.getCurrent();
    if (!g?.gameArea) return toast("Add zones first to define the search area.");
    const rTxt = (r) => (r >= 1000 ? `${r / 1000} km` : `${r} m`);
    // `approx` describes a card whose automatic source is a PROXY for the real feature. A card
    // with a lineKind sources the real thing and keeps `approx` only to word its fallback, so
    // advertising the proxy up front would now be false.
    const opts = TENTACLES.map((c) =>
      `<option value="${c.id}">${escapeHtml(c.label)} · ${rTxt(c.radius)}${c.approx && !c.lineKind ? ` (${escapeHtml(c.approx)})` : ""}</option>`
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
        <p class="muted">A “of the {places} within R of me, which are you closest to?” card. Pick one, tap YOUR location, then auto-find or place the candidates. The radius reaches out from you — “none” is a miss (a negative radar around you).</p>
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
    // Tap the seeker's location — the centre of the tentacle reach. Constrained to
    // the play area (the seeker is within the game region). Shared by both paths.
    const pickCentre = async (cat) => {
      const cpts = await this.pick(1, `Tap YOUR location — the centre of the ${rTxt(cat.radius)} tentacle.`, { constrainToArea: true });
      return cpts ? cpts[0] : null;
    };
    s.q("#tt-manual").onclick = async () => {
      const cat = resolveCat(s.q("#tt-cat").value);
      if (!cat) return toast("That category is unavailable.");
      s.close();
      const center = await pickCentre(cat);
      if (!center) return this.openPanel();
      // Seeker names the exact places within reach; the radius is measured from them.
      const feats = await this._assembleCandidates(cat, [], { minCount: 1, center, radius: cat.radius });
      if (!feats || !feats.length) return this.openPanel();
      this._chooseTentacle(cat, feats, center);
    };
    s.q("#tt-find").onclick = async () => {
      const cat = resolveCat(s.q("#tt-cat").value);
      if (!cat) return toast("That category is unavailable.");
      s.close();
      const center = await pickCentre(cat);
      if (!center) return this.openPanel();

      // Metro Lines: source real line geometry rather than proxying with stations (F1).
      // Falls back to the station path — visibly, with the approximation warning — when there
      // is no proxy, Overpass is down, or the board genuinely has no metro. A silent fallback
      // would hide that the seeker is back on the approximate question.
      if (cat.lineKind) {
        toast("Finding metro lines…");
        try {
          const { candidateLines } = await import("./lines.js");
          const { lines, hidden } = await candidateLines(cat.lineKind, g.gameArea, center, cat.radius);
          if (lines.length) return this._chooseTentacleLines(cat, lines, center, hidden);
          // Everything in range hidden by the rail filter is a DIFFERENT problem from no metro
          // here, and falling back to stations would quietly re-offer the lines they excluded.
          if (hidden) { toast(`All ${hidden} metro line${hidden > 1 ? "s" : ""} in range are hidden by your rail filter.`); return this.openPanel(); }
          toast(`No metro lines within ${rTxt(cat.radius)} of you — falling back to stations.`);
        } catch (e) {
          console.warn("metro line sourcing failed", e);
          toast("Couldn't load metro lines — falling back to stations.");
        }
      }

      toast("Searching…");
      const turf = window.turf;
      let feats = [], source = "google", reason = "primary";
      try {
        // Search the category within the tentacle radius OF THE SEEKER.
        // boundToRadius: the tentacle's reach IS the question ("within 2 km of me"), so the
        // OSM bbox must follow that disc. Querying the whole board here can time out, and
        // the failure surfaces as an empty candidate list rather than an error.
        ({ feats, source, reason } = await searchCategoryResilient(this.map, { center, radius: cat.radius, type: cat.type, keyword: cat.keyword, gameArea: g.gameArea, padMeters: 0, boundToRadius: true }));
      } catch (e) {
        toast(e.message);
        return this.openPanel();
      }
      // No clamp warning here: Tentacles searches a FIXED card radius (2 km / 25 km) around
      // the seeker, not the play area's diagonal, so it can never hit Google's 50 km ceiling.
      if (source === "overpass") toast(sourceToast(reason));
      // Keep only places within the tentacle radius of the seeker (the reach).
      feats = feats.filter((f) => turf.distance([center.lng, center.lat], [f.lng, f.lat], { units: "meters" }) <= cat.radius);
      if (!feats.length) toast(`No ${cat.label.toLowerCase()} within ${rTxt(cat.radius)} of you — add your own below.`);
      // Refine: tick which count, add missing by tap/search (biased to you).
      const chosen = await this._assembleCandidates(cat, feats, { minCount: 1, center, radius: cat.radius });
      if (!chosen || !chosen.length) return this.openPanel();
      this._chooseTentacle(cat, chosen, center);
    };
  }

  // Metro Lines, answered with a LINE (F1). Mirrors _chooseTentacle, but the candidates are
  // lines rather than points: the map draws each one, and the step stores its geometry so the
  // partition recomputes deterministically even if OSM changes later.
  _chooseTentacleLines(cat, lines, center, hidden = 0) {
    const rTxt = cat.radius >= 1000 ? `${cat.radius / 1000} km` : `${cat.radius} m`;
    const temp = [];
    // Number the lines to match the list, and colour every path of a line identically — a
    // line is many OSM ways and must read as one thing.
    lines.forEach((l, i) => {
      const colour = TENTACLE_LINE_COLOURS[i % TENTACLE_LINE_COLOURS.length];
      for (const path of l.paths) {
        temp.push(new google.maps.Polyline({
          path: path.map(([lat, lng]) => ({ lat, lng })),
          strokeColor: colour, strokeOpacity: 0.95, strokeWeight: 4, zIndex: 6, clickable: false, map: this.map,
        }));
      }
    });
    temp.push(new google.maps.Marker({ position: center, label: { text: "C", color: "#04252a", fontWeight: "700" }, title: "Your location", map: this.map }));
    temp.push(new google.maps.Circle({ center, radius: cat.radius, map: this.map, strokeColor: "#38bdf8", strokeOpacity: 0.9, strokeWeight: 2, fillColor: "#38bdf8", fillOpacity: 0.06, clickable: false }));

    const list = lines.map((l, i) => {
      const swatch = TENTACLE_LINE_COLOURS[i % TENTACLE_LINE_COLOURS.length];
      const km = l.distance >= 1000 ? `${(l.distance / 1000).toFixed(1)} km` : `${Math.round(l.distance)} m`;
      return `<label><input type="radio" name="tt-line" value="${i}"/> <span class="line-dot" style="background:${swatch}"></span> ${escapeHtml(l.label)} <span class="muted">· ${km} away</span></label>`;
    }).join("");

    const s = openSheet({
      title: "Tentacles",
      mapInteractive: true,
      bodyHTML: `
        <p class="muted">Metro lines within ${rTxt} of you (the blue circle). Which is the hider closest to?</p>
        ${hidden ? `<p class="warn-note">⚠ ${hidden} more line${hidden > 1 ? "s are" : " is"} in range but hidden by your rail filter, so ${hidden > 1 ? "they are" : "it is"} excluded from this partition. That's right if you're not playing on ${hidden > 1 ? "them" : "it"} — but the hider must be answering about the same set you are.</p>` : ""}
        ${lines.length < 2 ? `<p class="warn-note">⚠ Only one line is in range, so this can only tell you whether the hider is within ${rTxt} of you — it can't distinguish between lines.</p>` : ""}
        <div class="seg">${list}</div>
        <div class="seg"><label><input type="radio" name="tt-line" value="none"/> None — the hider is outside my ${rTxt} reach (a miss)</label></div>
        <div class="sheet-actions">
          <button id="ttl-cancel" class="btn btn-ghost">Cancel</button>
          <button id="ttl-add" class="btn btn-primary">Add question</button>
        </div>`,
      onClose: () => temp.forEach((o) => o.setMap(null)),
    });
    s.q("#ttl-cancel").onclick = () => s.close();
    s.q("#ttl-add").onclick = () => {
      const chosen = s.qa('input[name="tt-line"]').find((r) => r.checked);
      if (!chosen) return toast("Choose which line they're closest to, or None for a miss.");
      const val = chosen.value;
      // Store the geometry, not a reference to it: the partition must recompute identically
      // for the life of the game even if OSM is edited or the cache is cleared. `id` is what
      // describeStep and the Matching flow key on.
      const stored = lines.map((l, i) => ({ id: `ln_${i}_${l.key}`, label: l.label, paths: l.paths }));
      const inputs = { category: cat.id, categoryLabel: cat.label, radius: cat.radius, lines: stored, center };
      const answer = val === "none" ? { none: true } : { featureIndex: parseInt(val, 10) };
      this.addStep("tentacles", inputs, answer);
      s.close();
      toast("Tentacles question added.");
    };
  }

  _chooseTentacle(cat, features, center) {
    const rTxt = cat.radius >= 1000 ? `${cat.radius / 1000} km` : `${cat.radius} m`;
    const temp = features.map((f, i) =>
      new google.maps.Marker({ position: { lat: f.lat, lng: f.lng }, label: `${i + 1}`, map: this.map })
    );
    // Show the seeker centre + the tentacle REACH circle (the radius is measured
    // from the seeker), cleared with the sheet.
    if (center) {
      temp.push(new google.maps.Marker({ position: center, label: { text: "C", color: "#04252a", fontWeight: "700" }, title: "Your location", map: this.map }));
      temp.push(new google.maps.Circle({ center, radius: cat.radius, map: this.map, strokeColor: "#38bdf8", strokeOpacity: 0.9, strokeWeight: 2, fillColor: "#38bdf8", fillOpacity: 0.06, clickable: false }));
    }
    const s = openSheet({
      title: "Tentacles",
      mapInteractive: true,
      bodyHTML: `
        <p class="muted">${escapeHtml(cat.label)} within ${rTxt} of you (the blue circle). Which is the hider closest to?</p>
        ${cat.approx ? approxWarning(cat) : ""}
        ${this._featureListHTML("tt-feat", features)}
        <div class="seg"><label><input type="radio" name="tt-feat" value="none"/> None — the hider is outside my ${rTxt} reach (a miss)</label></div>
        <div class="row">
          <button id="tt-more" class="btn">➕ Add a candidate</button>
        </div>
        <div class="sheet-actions">
          <button id="tt-cancel2" class="btn btn-ghost">Cancel</button>
          <button id="tt-add" class="btn btn-primary">Add question</button>
        </div>`,
      onClose: () => temp.forEach((m) => m.setMap(null)),
    });
    this._wireFeatureSearch(s, "tt-feat");
    s.q("#tt-cancel2").onclick = () => s.close();
    // Escape hatch: if the hider names a place the auto-find missed, re-enter the candidate
    // picker seeded with what we already have, rather than forcing Cancel — which discarded
    // the whole sub-flow (centre and all) and meant restarting from startTentacles.
    s.q("#tt-more").onclick = async () => {
      s.close();
      const more = await this._assembleCandidates(cat, features, { minCount: 1, center, radius: cat.radius });
      // Cancelling the picker returns to the chooser unchanged — it must not lose the flow either.
      this._chooseTentacle(cat, more && more.length ? more : features, center);
    };
    s.q("#tt-add").onclick = () => {
      // Require an explicit pick — see the matching sheet above; "0" as a default silently
      // recorded a candidate the seeker never chose.
      const chosen = s.qa('input[name="tt-feat"]').find((r) => r.checked);
      if (!chosen) return toast("Choose which one they're closest to, or None for a miss.");
      const val = chosen.value;
      const inputs = { category: cat.id, categoryLabel: cat.label, radius: cat.radius, features, center };
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
    const units = store.getCurrent()?.settings?.units || "metric";
    const s = openSheet({
      title: card.label,
      bodyHTML: `
        <p class="muted"><strong>Your</strong> distance to the nearest ${escapeHtml(card.label.toLowerCase())}. The app buffers by this distance, then keeps the side matching the hider's answer.</p>
        ${addInputs.refSource === "osm" ? `<p class="muted">✓ Using real ${escapeHtml(card.label.toLowerCase())} geometry from OpenStreetMap — nothing to draw. It appears on the map once the question is added.</p>` : ""}
        <label class="fieldlbl">Your distance</label>
        ${distanceFieldHTML("m-dist", 500, units)}
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
      // Validate, never clamp — see the Radar sheet. Zero is rejected with its own reason
      // rather than accepted: turf.buffer(geometry, 0) returns null, so a 0-distance
      // question would silently eliminate nothing, and semantically it cannot divide the
      // map anyway (every point is farther than 0; "closer than 0" is a contradiction).
      const distance = readDistanceMeters(s, "m-dist", units); // metres, whatever was typed
      if (!Number.isFinite(distance)) return toast("Enter your distance as a number.");
      // Covers 0 and negatives, so it must not claim the input was 0 — a player who typed -5
      // and is told "a distance of 0" looks for a zero they never entered.
      if (distance <= 0) return toast("Your distance has to be greater than zero — enter how far you actually are.");
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
      <label class="fieldlbl">Reference ${escapeHtml(pluralLabel(card.label).toLowerCase())}</label>
      <div class="row">
        <button id="m-auto" class="btn btn-primary">🔍 Auto-find nearby</button>
        <button id="m-manual" class="btn">✋ Place my own</button>
      </div>
      <span id="m-msg" class="muted"></span>`;
    const setMsg = (t) => { const m = s.q("#m-msg"); if (m) m.textContent = t; };
    s.q("#m-auto").onclick = async () => {
      const g = store.getCurrent();
      const { center, radius, clamped, wanted } = this._searchParams(g.gameArea);
      setMsg("Searching…");
      let feats = [], source = "google", reason = "primary";
      try {
        ({ feats, source, reason } = await searchCategoryResilient(this.map, { center, radius, type: card.type, keyword: card.keyword, gameArea: g.gameArea }));
      } catch (e) { setMsg(e.message); return; }
      feats = this._nearAreaFeatures(feats, g.gameArea);
      s.close();
      if (source === "overpass") toast(sourceToast(reason));
      else if (clamped) toast(clampWarning(radius, wanted));
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

  // A reference line (coastline, borders, high-speed rail): buffer it.
  //
  // Sourced from OSM where the card names a lineKind, hand-drawn otherwise. The brief: "the
  // exact lines used automatically, without my input — Mumbai should not have an advantage in
  // any stage." A traced coastline is a guess that then eliminates real area, and how good a
  // guess it is varies by how well the player knows the coast — which is exactly the local
  // advantage this removes.
  async _measureLine(card) {
    if (card.lineKind) {
      // Drawing used to be reachable only when sourcing FAILED, which made "I want to draw
      // this one" indistinguishable from "the lookup broke". Ask instead: sourced stays the
      // default (that is the whole point of §G1), but a deliberate hand-drawn line is now a
      // first-class answer rather than a fallback — a board on a river the seeker means
      // rather than the coast, or a stretch of border they want to treat as one segment.
      const how = await this._lineSourceSheet(card);
      if (!how) return this.openPanel();
      if (how === "auto") {
        const auto = await this._autoLine(card);
        if (auto) return this._distanceSheet(card, auto);
        // _autoLine has already said why; fall through to drawing it by hand.
      }
    }
    const coords = await this._drawShape(2, `Draw the ${card.label} — tap along it, point by point`);
    if (!coords) return this.openPanel();
    this._distanceSheet(card, {
      refType: "line", refLabel: card.label,
      refGeometry: { type: "LineString", coordinates: coords.map((c) => [c.lng, c.lat]) },
    });
  }

  // "Use the real one, or draw it?" for a lineKind card. Resolves "auto" | "draw" | null.
  //
  // `many` is set by the Matching card, which asks about a SET of lines ("which are you nearest
  // to") where Measuring asks about one reference ("how far are you from the coastline"). Same
  // choice, same default, different grammar — the wording is not decoration here, it is what
  // tells the player whether they are about to draw one line or several.
  _lineSourceSheet(card, { many = false } = {}) {
    const label = (many ? pluralLabel(card.label) : card.label).toLowerCase();
    return new Promise((resolve) => {
      let out = null;
      const s = openSheet({
        title: card.label,
        bodyHTML: `
          <p class="muted">This question needs ${many ? "lines" : "a line"}, not ${many ? "points" : "a point"}.</p>
          <div class="seg" role="radiogroup">
            <label><input type="radio" name="ls-how" value="auto" checked/> Use the real ${label} — looked up automatically</label>
            <label><input type="radio" name="ls-how" value="draw"/> Draw ${many ? "them" : "it"} myself — tap along ${many ? "each one" : "it"}, point by point</label>
          </div>
          <div class="sheet-actions"><button id="ls-cancel" class="btn btn-ghost">Cancel</button><button id="ls-go" class="btn btn-primary">Continue</button></div>`,
        onClose: () => resolve(out),
      });
      s.q("#ls-cancel").onclick = () => s.close();
      s.q("#ls-go").onclick = () => {
        out = s.qa('input[name="ls-how"]').find((r) => r.checked)?.value || "auto";
        s.close();
      };
    });
  }

  // Real geometry for a lineKind card, or null to fall back to hand-drawing — having SAID so.
  // Every exit here is spoken: silently handing back a draw prompt would look identical to the
  // card having no auto-source at all, and the player would never learn the real coast was
  // one retry away.
  async _autoLine(card) {
    const g = store.getCurrent();
    if (!g?.gameArea) { toast("Draw a game area first."); return null; }
    toast(`Finding the ${card.label.toLowerCase()}…`);
    try {
      const { lineGeometry } = await import("./lines.js");
      const out = await lineGeometry(card.lineKind, g.gameArea, {
        level: card.level ?? null,
        divisionOrdinal: card.divisionOrdinal ?? null,
      });
      // null is a real answer, not a failure: no international border crosses a Mumbai board.
      // Saying "none here" and letting them draw is honest; a bare draw prompt would imply
      // the lookup never happened.
      if (!out) {
        toast(`No ${card.label.toLowerCase()} on this board — draw it if you meant something else.`);
        return null;
      }
      if (out.from === "cache-stale") toast(`Using an offline copy of the ${card.label.toLowerCase()}.`);
      // §5.6.1: the level is a nationwide constant, but which named area it resolves to on
      // THIS board is still worth showing — it's what confirms the question is well-posed.
      if (out.division?.names?.length) toast(`${card.label}: ${out.division.names.join(", ")}.`);
      return {
        refType: "line", refLabel: card.label, refSource: "osm",
        refGeometry: out.geometry,
      };
    } catch (e) {
      console.warn("line sourcing failed", e);
      // 400 is our request being wrong; anything else is the endpoint being busy (~64% of
      // individual Overpass calls fail). Collapsing them sends someone hunting a phantom bug.
      toast(e.status === 400
        ? `${card.label} request rejected: ${e.message} — draw it instead.`
        : `Couldn't load the ${card.label.toLowerCase()} — draw it instead.`);
      return null;
    }
  }

  // A hand-drawn polygon (a body of water): buffer outward from its shore.
  async _measureArea(card) {
    const pts = await this._drawShape(3, `Outline the ${card.label} on the map`, { ring: true });
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
