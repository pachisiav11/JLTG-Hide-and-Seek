// Elimination geometry engine (guide §5). Pure functions: given a Step's inputs +
// the game area, compute the GeoJSON region to ELIMINATE (shade/remove) plus any
// visual "guides" (circle outline, bisector line, points). Regions are recomputed
// deterministically from inputs, so history need not store big polygons (guide §6.2).

function T() {
  if (!window.turf) throw new Error("Turf.js not loaded.");
  return window.turf;
}
function feat(g) {
  return g && g.type === "Feature" ? g : T().feature(g);
}
function safeDiff(a, b) {
  try {
    const r = T().difference(T().featureCollection([feat(a), feat(b)]));
    return r ? r.geometry : null;
  } catch (e) { console.warn("difference failed", e); return null; }
}

// The active area is EMPTY: every enabled question, combined, rules out the whole board.
// This is a real and meaningful state — usually a mis-entered answer or an inconsistent
// hider — and is NOT the same as "no game area" and NOT an error. Callers must tell it
// apart from null, or a fully-eliminated game renders identically to a fresh one (A1).
export const EMPTY_AREA = Object.freeze({ __emptyArea: true });

// Set difference for the ACTIVE AREA specifically. Unlike safeDiff, "nothing remains" is
// a legitimate answer here rather than "this step eliminates nothing", so an empty result
// is reported as EMPTY_AREA and null is reserved for an actual failure.
function diffActive(a, b) {
  try {
    const r = T().difference(T().featureCollection([feat(a), feat(b)]));
    return r ? r.geometry : EMPTY_AREA;
  } catch (e) { console.warn("active-area difference failed", e); return null; }
}
function safeIntersect(a, b) {
  try {
    const r = T().intersect(T().featureCollection([feat(a), feat(b)]));
    return r ? r.geometry : null;
  } catch (e) { console.warn("intersect failed", e); return null; }
}
function safeUnion(a, b) {
  try {
    const r = T().union(T().featureCollection([feat(a), feat(b)]));
    return r ? r.geometry : null;
  } catch (e) { console.warn("union failed", e); return null; }
}

// --- Radar: centre + radius circle ---------------------------------------
function radar(step, gameArea) {
  const { center, radius } = step.inputs;      // radius in metres
  const side = step.answer?.side;               // "in" (Yes) | "out" (No)
  const circle = T().circle([center.lng, center.lat], radius / 1000, { units: "kilometers", steps: 72 });
  let eliminated = null;
  if (gameArea) {
    eliminated = side === "in"
      ? safeDiff(gameArea, circle)      // inside → remove everything outside the circle
      : safeIntersect(circle, gameArea); // outside → remove the circle
  } else {
    eliminated = side === "out" ? circle.geometry : null;
  }
  // `editable: "center"` marks the circle centre as a drag-to-reposition anchor
  // (Phase 7) — layers.js wires the drag back to inputs.center.
  return { eliminated, guides: [{ type: "circle", center, radius, editable: "center" }] };
}

// --- Thermometer: perpendicular bisector of A→B --------------------------
// Built in a LOCAL equirectangular projection (x = lng·cos(lat0), y = lat) so the
// bisector is truly equidistant on the ground at city scale. Doing this with
// great-circle destinations over ~200 km displaces the line by an amount
// comparable to a city-sized play area, which is wrong (see git history).
function thermometer(step, gameArea) {
  const { a, b } = step.inputs;
  const side = step.answer?.side;               // "hotter" (closer to B) | "colder"
  const lat0 = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const k = Math.cos(lat0) || 1e-6;             // longitude compression
  const unproj = (x, y) => [x / k, y];          // back to [lng, lat]

  const ax = a.lng * k, ay = a.lat, bx = b.lng * k, by = b.lat;
  const mx = (ax + bx) / 2, my = (ay + by) / 2; // midpoint
  let dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;                          // unit vector A→B
  const px = -dy, py = dx;                       // perpendicular (bisector direction)

  // Half-extent of the eliminated strip. A fixed ±3° (~330 km) does NOT "cover any play
  // area": Jet Lag is played across whole countries, and on a Japan-sized board a
  // Tokyo→Osaka "hotter" left Sapporo — unambiguously colder — un-eliminated, because the
  // strip simply didn't reach it. Derive the extent from the board instead: measure to the
  // game area's furthest bbox corner IN PROJECTED UNITS (comparable to px/py/dx/dy) so the
  // strip always overshoots, at any latitude and any board size.
  let L = 3; // fallback only when there is no game area to measure against
  if (gameArea) {
    try {
      const bb = T().bbox(feat(gameArea)); // [minLng,minLat,maxLng,maxLat]
      const corners = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]];
      let far = 0;
      for (const [lng, lat] of corners) far = Math.max(far, Math.hypot(lng * k - mx, lat - my));
      // 1.5x the furthest corner: the strip is convex, so covering every corner covers the
      // whole board. Never shrink below the old constant.
      L = Math.max(3, far * 1.5);
    } catch (_) { /* keep the fallback */ }
  }

  // Bisector endpoints, then offset the whole strip toward the eliminated side.
  const E1 = [mx + px * L, my + py * L];
  const E2 = [mx - px * L, my - py * L];
  // Hotter → hider on B's side → eliminate A's side (offset toward A = −d).
  const ox = side === "hotter" ? -dx : dx;
  const oy = side === "hotter" ? -dy : dy;
  const F1 = [E1[0] + ox * 2 * L, E1[1] + oy * 2 * L];
  const F2 = [E2[0] + ox * 2 * L, E2[1] + oy * 2 * L];
  const ring = [E1, E2, F2, F1, E1].map(([x, y]) => unproj(x, y));
  const elimHalf = T().polygon([ring]);

  const eliminated = gameArea ? safeIntersect(elimHalf, gameArea) : elimHalf.geometry;

  // A visible bisector guide (the actual dividing line), sized to the play area so
  // it reads as "this splits the region" rather than a faint edge off-screen. The
  // A→B connector uses the same axis but the bisector is what the answer divides on.
  let bisG = L;
  if (gameArea) {
    try {
      const bb = T().bbox(feat(gameArea));
      // The lng span must be projected (x = lng·k) before being compared with the lat
      // span or used alongside px/py — mixing raw degrees into projected space made the
      // guide the wrong length, increasingly so away from the equator.
      bisG = Math.min(L, Math.max((bb[2] - bb[0]) * k, bb[3] - bb[1]) * 0.75 || L);
    } catch (_) { /* keep default */ }
  }
  const G1 = unproj(mx + px * bisG, my + py * bisG);
  const G2 = unproj(mx - px * bisG, my - py * bisG);
  return {
    eliminated,
    guides: [
      // A/B are drag-to-reposition anchors (Phase 7): dragging rewrites inputs.a/b.
      { type: "point", lat: a.lat, lng: a.lng, label: "A", editable: "a" },
      { type: "point", lat: b.lat, lng: b.lng, label: "B", editable: "b" },
      { type: "line", from: a, to: b },
      { type: "line", from: { lat: G1[1], lng: G1[0] }, to: { lat: G2[1], lng: G2[0] } },
    ],
  };
}

// turf.voronoi returns a NULL cell for any point that exactly coincides with
// another input point (e.g. Places sometimes lists two venues at one coordinate).
// Nudge each coincident point ~0.6 m apart so every input gets a valid, still
// index-aligned cell. We check each nudged position against ALL already-placed
// points (not just the raw duplicate group), so a nudge can never land back onto
// another distinct input and re-create the collision it exists to prevent.
// Sub-metre offsets don't affect the elimination at map scale.
function dejitter(coords) {
  const used = new Set();
  const key = (lng, lat) => lng.toFixed(6) + "," + lat.toFixed(6);
  return coords.map(([lng, lat]) => {
    let x = lng, y = lat, n = 0;
    while (used.has(key(x, y))) { n++; const d = n * 6e-6; x = lng + d; y = lat + d; } // ~0.6 m per step
    used.add(key(x, y));
    return [x, y];
  });
}

// --- Voronoi cells shared by Matching & Tentacles ------------------------
// Returns { cells } where cells[i] is the clipped Voronoi cell geometry for
// features[i] (or null). The partition is computed over a bbox that contains both
// the features and the game area, then each cell is clipped to the game area.
//
// IMPORTANT: turf.voronoi treats lng/lat as PLANAR, so away from the equator the
// cells are stretched in longitude and no longer match the true GEODESIC "nearest
// place" partition — a hider could truthfully answer "nearest = A" yet sit in A's
// distorted cell's neighbour, so keeping A's cell would wrongly eliminate the true
// location. We therefore compute the Voronoi in a longitude-COMPRESSED space
// (x = lng·cos(lat0), same trick as the thermometer bisector) and unproject the
// resulting cells back to lng/lat before clipping. This makes the cells match
// straight-line ground distance to a very good approximation across a play area.
function voronoiCells(features, gameArea) {
  const lat0 = features.reduce((s, f) => s + f.lat, 0) / features.length;
  const k = Math.cos((lat0 * Math.PI) / 180) || 1e-6; // longitude compression
  const proj = ([lng, lat]) => [lng * k, lat];
  const unproj = ([x, y]) => [x / k, y];
  const pts = dejitter(features.map((f) => [f.lng, f.lat])).map((c) => T().point(proj(c)));
  // bbox in the projected space, covering the projected features + game-area extent.
  const gbb = T().bbox(feat(gameArea));
  const corners = [proj([gbb[0], gbb[1]]), proj([gbb[2], gbb[3]])].map((c) => T().point(c));
  let bbox = T().bbox(T().featureCollection([...pts, ...corners]));
  const padX = (bbox[2] - bbox[0]) * 0.15 || 0.05;
  const padY = (bbox[3] - bbox[1]) * 0.15 || 0.05;
  bbox = [bbox[0] - padX, bbox[1] - padY, bbox[2] + padX, bbox[3] + padY];
  let raw;
  try {
    raw = T().voronoi(T().featureCollection(pts), { bbox });
  } catch (e) {
    // Do NOT swallow this. Returning all-null cells let the caller hand back
    // `eliminated: null`, which nothing treats as an error: _render's per-step catch never
    // incremented `failed`, so the "N questions failed" banner never appeared, and the step
    // stayed checked and enabled while contributing zero shading. Degeneration is realistic
    // — near-collinear seeds, i.e. stations along one straight rail line, exactly the Metro
    // Lines and Station's Name Length candidate sets.
    throw new Error(`Voronoi partition failed for ${features.length} candidates: ${e.message}`);
  }
  const cells = (raw.features || []).map((cell) => {
    if (!cell) return null;
    // Unproject the cell polygon back to lng/lat, then clip to the game area.
    const rings = cell.geometry.coordinates.map((ring) => ring.map(unproj));
    return safeIntersect(T().polygon(rings), gameArea);
  });
  // turf can degenerate WITHOUT throwing: collinear seeds yield no usable cells at all.
  // That is the same silent no-op question, so it gets the same treatment.
  if (!cells.length || cells.every((c) => !c)) {
    throw new Error(`Voronoi partition produced no usable cells for ${features.length} candidates (collinear?)`);
  }
  return { cells };
}

// Matching: keep OR shade the selected feature's Voronoi cell.
function voronoiTool(step, gameArea) {
  const { features } = step.inputs;
  const { featureIndex, keep } = step.answer || {};
  // No per-candidate point markers persist after the question: they clutter the
  // map ("rogue points") once the answer is recorded. The candidates are shown
  // live via temporary markers during selection; here only the cell outlines +
  // resulting shaded region remain.
  const guides = [];
  if (!gameArea || !features || features.length < 2 || featureIndex == null) {
    return { eliminated: null, guides };
  }
  const { cells } = voronoiCells(features, gameArea);
  for (const c of cells) if (c) for (const ring of geojsonRings(c)) guides.push({ type: "outline", ring });
  const selected = cells[featureIndex];
  // A null cell here means the partition degenerated for the answered candidate. Failing
  // loudly lets the existing banner fire instead of leaving the question silently inert.
  if (!selected) throw new Error(`No Voronoi cell for the selected candidate (index ${featureIndex}) — the partition degenerated.`);
  const eliminated = keep ? safeDiff(gameArea, selected) : selected;
  return { eliminated, guides };
}

// [lat,lng] ring -> closed GeoJSON polygon geometry (Turf axis order).
function ringToPoly(ring) {
  const r = ring.map(([lat, lng]) => [lng, lat]);
  const a = r[0], b = r[r.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) r.push([a[0], a[1]]);
  return T().polygon([r]).geometry;
}

// Sample a drawn line ({lat,lng}[]) into GeoJSON points every ~stepMeters.
function densifyLine(coords, stepMeters) {
  const turf = T();
  const line = turf.lineString(coords.map((c) => [c.lng, c.lat]));
  const total = turf.length(line, { units: "meters" });
  const n = Math.max(1, Math.floor(total / stepMeters));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    pts.push(turf.along(line, (total * i) / n, { units: "meters" }).geometry.coordinates);
  }
  return pts;
}

// --- Matching dispatch: nearest / nameLength / nearestLine / region -------
function matching(step, gameArea) {
  switch (step.inputs?.mode) {
    case "nameLength": return matchingNameLength(step, gameArea);
    case "nearestLine": return matchingNearestLine(step, gameArea);
    case "region": return matchingRegion(step, gameArea);
    default: return voronoiTool(step, gameArea); // "nearest"
  }
}

// Nearest transit station, grouped by station-name letter count. The SEEKER's
// nearest-station name length is `length`; the hider answered whether theirs
// matches (`match !== false`). Match → the hider shares one of those cells, so
// keep their union; no-match → the hider is in NONE of them, so eliminate the union.
function matchingNameLength(step, gameArea) {
  const { features } = step.inputs;
  const { length, match } = step.answer || {};
  const keepMatch = match !== false; // default true = backward-compat "same"
  const guides = []; // candidate points don't persist (see voronoiTool)
  if (!gameArea || !features || features.length < 2 || length == null) return { eliminated: null, guides };
  const { cells } = voronoiCells(features, gameArea);
  for (const c of cells) if (c) for (const ring of geojsonRings(c)) guides.push({ type: "outline", ring });
  let union = null;
  cells.forEach((c, i) => { if (c && features[i].len === length) union = union ? safeUnion(union, c) : c; });
  if (!union) return { eliminated: null, guides };
  // Match → keep those cells (remove the rest); no-match → remove those cells.
  return { eliminated: keepMatch ? safeDiff(gameArea, union) : union, guides };
}

// Nearest of several hand-drawn lines/paths: densify every line to points, take
// the point Voronoi, then keep OR eliminate the union of cells belonging to the
// SEEKER's chosen line, depending on whether the hider answered "same" (`match`).
function matchingNearestLine(step, gameArea) {
  const { lines } = step.inputs;
  const { lineId, match } = step.answer || {};
  const keepMatch = match !== false; // default true = backward-compat "same"
  const guides = (lines || []).map((ln) => ({ type: "polyline", coords: ln.coords }));
  if (!gameArea || !lines || !lines.length || lineId == null) return { eliminated: null, guides };
  const turf = T();
  const rawCoords = [], owner = [];
  lines.forEach((ln, idx) => {
    if ((ln.coords || []).length >= 2) for (const c of densifyLine(ln.coords, 400)) { rawCoords.push(c); owner.push(idx); }
  });
  if (rawCoords.length < 2) return { eliminated: null, guides };
  // Longitude-compress before the Voronoi (see voronoiCells) so cells match ground
  // distance, not planar lng/lat — otherwise the chosen line's region is skewed.
  const lat0 = rawCoords.reduce((s, c) => s + c[1], 0) / rawCoords.length;
  const k = Math.cos((lat0 * Math.PI) / 180) || 1e-6;
  const proj = ([lng, lat]) => [lng * k, lat];
  const unproj = ([x, y]) => [x / k, y];
  const allPts = dejitter(rawCoords).map((c) => turf.point(proj(c)));
  const gbb = turf.bbox(feat(gameArea));
  const corners = [proj([gbb[0], gbb[1]]), proj([gbb[2], gbb[3]])].map((c) => turf.point(c));
  let bbox = turf.bbox(turf.featureCollection([...allPts, ...corners]));
  const padX = (bbox[2] - bbox[0]) * 0.15 || 0.05, padY = (bbox[3] - bbox[1]) * 0.15 || 0.05;
  bbox = [bbox[0] - padX, bbox[1] - padY, bbox[2] + padX, bbox[3] + padY];
  let raw;
  try { raw = turf.voronoi(turf.featureCollection(allPts), { bbox }); }
  // Same reasoning as voronoiCells: swallowing this returns `eliminated: null`, which no
  // caller treats as an error, so the question stays enabled and silently does nothing.
  catch (e) { throw new Error(`Nearest-line partition failed for ${lines.length} lines: ${e.message}`); }
  const chosen = lines.findIndex((l) => l.id === lineId);
  let keep = null;
  (raw.features || []).forEach((cell, i) => {
    if (cell && owner[i] === chosen) {
      const unpoly = turf.polygon(cell.geometry.coordinates.map((ring) => ring.map(unproj)));
      const clip = safeIntersect(unpoly, gameArea);
      if (clip) keep = keep ? safeUnion(keep, clip) : clip;
    }
  });
  if (!keep) return { eliminated: null, guides };
  // Match → keep the chosen line's region; no-match → eliminate it.
  return { eliminated: keepMatch ? safeDiff(gameArea, keep) : keep, guides };
}

// Keep the inside (or, when inside===false, the outside) of a drawn [lat,lng]
// ring within the game area. Shared by Matching (admin division / landmass) and
// Measuring (sea level) — both are the same "draw a region, keep a side" op.
function keepRegionSide(gameArea, ring, inside) {
  if (!gameArea || !ring || ring.length < 3) return null;
  const poly = ringToPoly(ring);
  return inside ? safeDiff(gameArea, poly) : safeIntersect(poly, gameArea);
}

// Which drawn region (admin division / landmass) the hider is inside: keep that
// side. answer.inside === false keeps the OUTSIDE instead.
function matchingRegion(step, gameArea) {
  const { ring } = step.inputs;
  const inside = step.answer?.inside !== false;
  const guides = ring ? [{ type: "outline", ring: ring.map(([lat, lng]) => ({ lat, lng })), bold: true }] : [];
  return { eliminated: keepRegionSide(gameArea, ring, inside), guides };
}

// --- Tentacles: fixed-radius "which of these are you closest to?" --------
// A tentacle card has a FIXED radius R that is the SEEKER's reach: "of the {places}
// within R of ME, which are you closest to?". Two answers:
//  • closest = feature P  → the hider is within R of the SEEKER (`center`) AND in
//    P's Voronoi cell, so KEEP cell(P) ∩ circle(center,R); eliminate the rest.
//  • none / outside       → the hider is NOT within R of the seeker — functionally a
//    radar MISS of radius R centred on the seeker, so ELIMINATE circle(center,R).
// The radius is measured from the SEEKER, not each place. Legacy steps saved before
// this change carry no `center` and fall back to the old per-POI-circle behavior so
// old saved/imported games still eliminate correctly.
function tentacles(step, gameArea) {
  const { features, radius, center } = step.inputs;
  const { featureIndex, none } = step.answer || {};
  const R = radius; // metres

  // ---- Pre-rebuild steps with no radius (plain nearest-cell partition) ----
  // These must NOT be handed to voronoiTool. That is Matching-shaped and destructures
  // `{ featureIndex, keep }`, but a tentacles answer only ever carries `{ featureIndex }`
  // or `{ none: true }`. `keep` came back undefined, so `keep ? safeDiff(...) : selected`
  // took the falsy branch and eliminated `selected` — shading exactly the cell the hider
  // said they were CLOSEST to. The inverse of the truth, silently.
  if (radius == null) {
    const guides = [];
    if (!gameArea || !features || features.length < 2 || featureIndex == null) {
      // `{ none: true }` has no meaning here: with no radius there are no circles and
      // every point is nearest to something, so there is nothing to eliminate.
      return { eliminated: null, guides };
    }
    const { cells } = voronoiCells(features, gameArea);
    for (const c of cells) if (c) for (const ring of geojsonRings(c)) guides.push({ type: "outline", ring });
    const cell = cells[featureIndex];
    if (!cell) throw new Error(`No Voronoi cell for the selected candidate (index ${featureIndex}) — the partition degenerated.`);
    // "Closest to P" ⇒ KEEP P's cell, eliminate everything else.
    return { eliminated: safeDiff(gameArea, cell), guides };
  }

  const guides = [];
  if (!gameArea || !features || !features.length || !R) return { eliminated: null, guides };
  const circleGeom = (lng, lat) => T().circle([lng, lat], R / 1000, { units: "kilometers", steps: 64 }).geometry;

  // ---- Seeker-centric model (new steps carry `center`) --------------------
  if (center) {
    const seeker = circleGeom(center.lng, center.lat);
    guides.push({ type: "circle", center: { lat: center.lat, lng: center.lng }, radius: R });
    // Miss: the hider is outside the seeker's reach → eliminate INSIDE the circle.
    if (none) return { eliminated: safeIntersect(seeker, gameArea), guides };

    if (featureIndex == null) return { eliminated: null, guides };
    const P = features[featureIndex];
    if (!P) return { eliminated: null, guides };
    // Hit: within reach AND closest to P. With one candidate the whole area is P's
    // cell, so keep = area ∩ seeker circle.
    let cell = gameArea;
    if (features.length >= 2) {
      const { cells } = voronoiCells(features, gameArea);
      for (const c of cells) if (c) for (const ring of geojsonRings(c)) guides.push({ type: "outline", ring });
      cell = cells[featureIndex];
      if (!cell) throw new Error(`No Voronoi cell for the selected candidate (index ${featureIndex}) — the partition degenerated.`);
    }
    const keep = safeIntersect(cell, seeker);
    if (!keep) return { eliminated: null, guides };
    return { eliminated: safeDiff(gameArea, keep), guides };
  }

  // ---- Legacy per-POI-circle model (old steps without a seeker `center`) --
  const circleOf = (f) => circleGeom(f.lng, f.lat);
  if (none) {
    let union = null;
    for (const f of features) {
      guides.push({ type: "circle", center: { lat: f.lat, lng: f.lng }, radius: R });
      union = union ? safeUnion(union, circleOf(f)) : circleOf(f);
    }
    const eliminated = union ? safeIntersect(union, gameArea) : null;
    return { eliminated, guides };
  }
  if (featureIndex == null) return { eliminated: null, guides };
  const P = features[featureIndex];
  if (!P) return { eliminated: null, guides };
  guides.push({ type: "circle", center: { lat: P.lat, lng: P.lng }, radius: R });
  let cell = gameArea;
  if (features.length >= 2) {
    const { cells } = voronoiCells(features, gameArea);
    for (const c of cells) if (c) for (const ring of geojsonRings(c)) guides.push({ type: "outline", ring });
    cell = cells[featureIndex];
    if (!cell) throw new Error(`No Voronoi cell for the selected candidate (index ${featureIndex}) — the partition degenerated.`);
  }
  const keepRegion = safeIntersect(cell, circleOf(P));
  if (!keepRegion) return { eliminated: null, guides };
  return { eliminated: safeDiff(gameArea, keepRegion), guides };
}

// Straight-line distance (metres) from a point to a game-area polygon: 0 if the
// point is inside, else the distance to the nearest boundary edge. Used to bound
// which candidate places are relevant to a tentacle radius.
export function distancePointToArea(pt, area) {
  const turf = T();
  const p = turf.point([pt.lng, pt.lat]);
  try {
    const poly = feat(area);
    if (turf.booleanPointInPolygon(p, poly)) return 0;
    const lines = turf.polygonToLine(poly);
    let best = Infinity;
    const consider = (lineFeat) => {
      try { best = Math.min(best, turf.pointToLineDistance(p, lineFeat, { units: "meters" })); } catch (_) {}
    };
    if (lines.type === "FeatureCollection") lines.features.forEach(consider);
    else consider(lines);
    return best;
  } catch (e) {
    console.warn("distancePointToArea failed", e);
    return Infinity;
  }
}

// Extract outer rings of a geometry as arrays of {lat,lng} for guide drawing.
function geojsonRings(geom) {
  const rings = [];
  let polys = [];
  if (geom.type === "MultiPolygon") polys = geom.coordinates;
  else if (geom.type === "Polygon") polys = [geom.coordinates];
  for (const poly of polys) if (poly[0]) rings.push(poly[0].map(([lng, lat]) => ({ lat, lng })));
  return rings;
}

// --- Measuring: buffer of a reference geometry ---------------------------
// "Within d of X" keeps inside the buffer (side "in"); "beyond d" keeps outside
// (side "out"). Reference is a Places point set (MultiPoint) or a bundled line.
function bufferGeometry(geom, meters) {
  try {
    const b = T().buffer(feat(geom), meters, { units: "meters" });
    return b ? b.geometry : null;
  } catch (e) { console.warn("buffer failed", e); return null; }
}

function measuring(step, gameArea) {
  const { refType, refGeometry, ring, distance } = step.inputs;
  const side = step.answer?.side; // "in" (within/closer) | "out" (beyond/farther)
  const guides = [];

  // Region mode (Sea Level): elevation can't be derived from map geometry, so the
  // hider's revealed level is drawn as a region and we simply keep that side — no
  // distance buffer. answer.inside === false keeps the outside instead.
  if (refType === "region") {
    if (ring) guides.push({ type: "outline", ring: ring.map(([lat, lng]) => ({ lat, lng })), bold: true });
    const inside = step.answer?.inside !== false;
    return { eliminated: keepRegionSide(gameArea, ring, inside), guides };
  }

  // Reference visuals for the buffer modes (line / area). Per-candidate points
  // don't persist (see voronoiTool); the buffer outline below is the reference
  // that stays on the map for point-set cards.
  if (refGeometry?.type === "LineString") guides.push({ type: "polyline", coords: refGeometry.coordinates.map(([lng, lat]) => ({ lat, lng })) });
  if (refGeometry?.type === "Polygon") for (const r of geojsonRings(refGeometry)) guides.push({ type: "outline", ring: r });

  const buffer = refGeometry ? bufferGeometry(refGeometry, distance) : null;
  if (!buffer || !gameArea) return { eliminated: null, guides };
  for (const r of geojsonRings(buffer)) guides.push({ type: "outline", ring: r });

  const eliminated = side === "in" ? safeDiff(gameArea, buffer) : safeIntersect(buffer, gameArea);
  return { eliminated, guides };
}

export function computeElimination(step, gameArea) {
  switch (step.tool) {
    case "radar": return radar(step, gameArea);
    case "thermometer": return thermometer(step, gameArea);
    case "matching": return matching(step, gameArea);
    case "tentacles": return tentacles(step, gameArea);
    case "measuring": return measuring(step, gameArea);
    default: return { eliminated: null, guides: [] };
  }
}

// activeArea = gameArea \ union(all enabled eliminations). Because it's a pure set
// difference, each elimination is computed against the FULL game area, making the
// result order-independent (toggling any step recomputes correctly).
// `onFail(stepId, reason)` reports a step whose contribution could not be folded into the
// mask. Without it these failures are invisible: the caller renders a board that looks
// perfectly healthy while silently missing an elimination.
export function computeActiveArea(gameArea, steps, onFail) {
  if (!gameArea) return null;
  const elims = [];
  for (const s of steps || []) {
    if (!s.enabled) continue;
    // Contain a single malformed step (Phase 8): a bad geometry throwing here must
    // not blank the whole active area — skip that step's contribution and continue.
    let eliminated = null;
    try { ({ eliminated } = computeElimination(s, gameArea)); }
    catch (e) {
      console.error(`Step ${s.id} (${s.tool}) failed to compute; skipping it.`, e);
      onFail?.(s.id, "compute");
      continue;
    }
    if (eliminated) elims.push({ id: s.id, geom: eliminated });
  }
  if (!elims.length) return gameArea;
  let removed = elims[0].geom;
  for (let i = 1; i < elims.length; i++) {
    const merged = safeUnion(removed, elims[i].geom);
    if (!merged) {
      // safeUnion already swallowed its own exception and returned null. The old
      // `|| removed` fallback then dropped this step's ENTIRE eliminated region from the
      // mask — the board showed area as still-possible that a question had ruled out, with
      // nothing thrown and no banner. Keep going (dropping one step beats blanking the
      // board), but make the loss visible.
      console.error(`Step ${elims[i].id}: union failed; its elimination is missing from the mask.`);
      onFail?.(elims[i].id, "union");
      continue;
    }
    removed = merged;
  }
  // EMPTY_AREA (not null) when the eliminations cover everything, so the caller can
  // shade the whole board instead of falling back to it and showing a fresh game.
  return diffActive(gameArea, removed);
}

// Short human-readable summary for the layers list.
export function describeStep(step) {
  if (step.tool === "radar") {
    const r = step.inputs.radius;
    const rTxt = r >= 1000 ? `${(r / 1000).toFixed(r % 1000 ? 1 : 0)} km` : `${Math.round(r)} m`;
    return `Radar · ${rTxt} · ${step.answer?.side === "in" ? "inside (Yes)" : "outside (No)"}`;
  }
  if (step.tool === "thermometer") {
    return `Thermometer · ${step.answer?.side === "hotter" ? "hotter (→B)" : "colder (→A)"}`;
  }
  if (step.tool === "matching") {
    const cat = step.inputs.categoryLabel || step.inputs.category || "feature";
    const mode = step.inputs.mode;
    const same = (m) => (m === false ? "differ" : "match");
    if (mode === "nameLength") return `Matching · name length ${step.answer?.length} · ${same(step.answer?.match)}`;
    if (mode === "region") return `Matching · ${cat} · ${step.answer?.inside === false ? "differ" : "match"}`;
    if (mode === "nearestLine") {
      const ln = (step.inputs.lines || []).find((l) => l.id === step.answer?.lineId);
      return `Matching · ${cat} · “${ln?.label || "?"}” · ${same(step.answer?.match)}`;
    }
    const sel = (step.inputs.features || [])[step.answer?.featureIndex];
    return `Matching · ${cat} · “${sel?.name || "?"}” · ${step.answer?.keep === false ? "differ" : "match"}`;
  }
  if (step.tool === "tentacles") {
    const cat = step.inputs.categoryLabel || step.inputs.category || "places";
    const R = step.inputs.radius || 0;
    const rTxt = R >= 1000 ? `${R / 1000} km` : `${Math.round(R)} m`;
    if (step.answer?.none) return `Tentacles · ${cat} · none within ${rTxt}`;
    const sel = (step.inputs.features || [])[step.answer?.featureIndex];
    return `Tentacles · ${cat} · closest “${sel?.name || "?"}” (${rTxt})`;
  }
  if (step.tool === "measuring") {
    const ref = step.inputs.refLabel || "reference";
    if (step.inputs.refType === "region") {
      return `Measuring · ${ref} · ${step.answer?.inside === false ? "outside" : "inside"}`;
    }
    const d = step.inputs.distance;
    const dTxt = d >= 1000 ? `${(d / 1000).toFixed(d % 1000 ? 1 : 0)} km` : `${Math.round(d)} m`;
    const rel = step.answer?.side === "in" ? "within" : "beyond";
    return `Measuring · ${rel} ${dTxt} of ${ref}`;
  }
  return step.tool;
}
