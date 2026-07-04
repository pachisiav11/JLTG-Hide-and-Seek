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
  return { eliminated, guides: [{ type: "circle", center, radius }] };
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
  const L = 3;                                   // ~330 km half-extent: covers any play area

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
  return {
    eliminated,
    guides: [
      { type: "point", lat: a.lat, lng: a.lng, label: "A" },
      { type: "point", lat: b.lat, lng: b.lng, label: "B" },
      { type: "line", from: a, to: b },
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
function voronoiCells(features, gameArea) {
  const pts = dejitter(features.map((f) => [f.lng, f.lat])).map((c) => T().point(c));
  const collection = T().featureCollection([...pts, feat(gameArea)]);
  let bbox = T().bbox(collection);
  // Pad the bbox so edge cells are unbounded-safe.
  const padX = (bbox[2] - bbox[0]) * 0.15 || 0.05;
  const padY = (bbox[3] - bbox[1]) * 0.15 || 0.05;
  bbox = [bbox[0] - padX, bbox[1] - padY, bbox[2] + padX, bbox[3] + padY];
  let raw;
  try {
    raw = T().voronoi(T().featureCollection(pts), { bbox });
  } catch (e) {
    console.warn("voronoi failed", e);
    return { cells: features.map(() => null) };
  }
  const cells = (raw.features || []).map((cell) => (cell ? safeIntersect(cell, gameArea) : null));
  return { cells };
}

// Matching: keep OR shade the selected feature's Voronoi cell.
function voronoiTool(step, gameArea) {
  const { features } = step.inputs;
  const { featureIndex, keep } = step.answer || {};
  const guides = [
    ...(features || []).map((f, i) => ({ type: "point", lat: f.lat, lng: f.lng, label: `${i + 1}` })),
  ];
  if (!gameArea || !features || features.length < 2 || featureIndex == null) {
    return { eliminated: null, guides };
  }
  const { cells } = voronoiCells(features, gameArea);
  for (const c of cells) if (c) for (const ring of geojsonRings(c)) guides.push({ type: "outline", ring });
  const selected = cells[featureIndex];
  if (!selected) return { eliminated: null, guides };
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

// Nearest transit station, grouped by station-name letter count: keep the union
// of Voronoi cells whose station name has the revealed number of letters.
function matchingNameLength(step, gameArea) {
  const { features } = step.inputs;
  const { length } = step.answer || {};
  const guides = (features || []).map((f, i) => ({ type: "point", lat: f.lat, lng: f.lng, label: `${f.len}` }));
  if (!gameArea || !features || features.length < 2 || length == null) return { eliminated: null, guides };
  const { cells } = voronoiCells(features, gameArea);
  for (const c of cells) if (c) for (const ring of geojsonRings(c)) guides.push({ type: "outline", ring });
  let keep = null;
  cells.forEach((c, i) => { if (c && features[i].len === length) keep = keep ? safeUnion(keep, c) : c; });
  if (!keep) return { eliminated: null, guides };
  return { eliminated: safeDiff(gameArea, keep), guides };
}

// Nearest of several hand-drawn lines/paths: densify every line to points, take
// the point Voronoi, then keep the union of cells belonging to the chosen line.
function matchingNearestLine(step, gameArea) {
  const { lines } = step.inputs;
  const { lineId } = step.answer || {};
  const guides = (lines || []).map((ln) => ({ type: "polyline", coords: ln.coords }));
  if (!gameArea || !lines || !lines.length || lineId == null) return { eliminated: null, guides };
  const turf = T();
  const rawCoords = [], owner = [];
  lines.forEach((ln, idx) => {
    if ((ln.coords || []).length >= 2) for (const c of densifyLine(ln.coords, 400)) { rawCoords.push(c); owner.push(idx); }
  });
  if (rawCoords.length < 2) return { eliminated: null, guides };
  const allPts = dejitter(rawCoords).map((c) => turf.point(c));
  let bbox = turf.bbox(turf.featureCollection([...allPts, feat(gameArea)]));
  const padX = (bbox[2] - bbox[0]) * 0.15 || 0.05, padY = (bbox[3] - bbox[1]) * 0.15 || 0.05;
  bbox = [bbox[0] - padX, bbox[1] - padY, bbox[2] + padX, bbox[3] + padY];
  let raw;
  try { raw = turf.voronoi(turf.featureCollection(allPts), { bbox }); }
  catch (e) { console.warn("nearestLine voronoi failed", e); return { eliminated: null, guides }; }
  const chosen = lines.findIndex((l) => l.id === lineId);
  let keep = null;
  (raw.features || []).forEach((cell, i) => {
    if (cell && owner[i] === chosen) { const clip = safeIntersect(cell, gameArea); if (clip) keep = keep ? safeUnion(keep, clip) : clip; }
  });
  if (!keep) return { eliminated: null, guides };
  return { eliminated: safeDiff(gameArea, keep), guides };
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
  const guides = ring ? [{ type: "outline", ring: ring.map(([lat, lng]) => ({ lat, lng })) }] : [];
  return { eliminated: keepRegionSide(gameArea, ring, inside), guides };
}

// --- Tentacles: fixed-radius "which of these are you closest to?" --------
// A tentacle card has a FIXED radius R. Two answers:
//  • closest = feature P  → the hider is within R of P AND closer to P than any
//    other listed place, so KEEP P's Voronoi cell ∩ circle(P,R); eliminate the rest.
//  • none in range        → the hider is within R of NONE of them, so eliminate the
//    UNION of every circle(P,R) (a radar-"outside" over all the places).
// Candidate features are pre-filtered (in the flow) to those whose R-circle can
// actually reach the play area, so far-off places never distort the partition.
function tentacles(step, gameArea) {
  const { features, radius } = step.inputs;
  const { featureIndex, none } = step.answer || {};
  const R = radius; // metres
  // Backward-compat: pre-rebuild tentacles steps had no fixed radius and were a
  // plain nearest-cell partition (routed through voronoiTool). Recompute those
  // with the old behavior so old saved/imported games still eliminate correctly.
  if (radius == null) return voronoiTool(step, gameArea);
  const guides = (features || []).map((f, i) => ({ type: "point", lat: f.lat, lng: f.lng, label: `${i + 1}` }));
  if (!gameArea || !features || !features.length || !R) return { eliminated: null, guides };

  const circleOf = (f) => T().circle([f.lng, f.lat], R / 1000, { units: "kilometers", steps: 64 });

  // "None in range" → eliminate everything within R of any listed place.
  if (none) {
    let union = null;
    for (const f of features) {
      guides.push({ type: "circle", center: { lat: f.lat, lng: f.lng }, radius: R });
      union = union ? safeUnion(union, circleOf(f).geometry) : circleOf(f).geometry;
    }
    const eliminated = union ? safeIntersect(union, gameArea) : null;
    return { eliminated, guides };
  }

  if (featureIndex == null) return { eliminated: null, guides };
  const P = features[featureIndex];
  if (!P) return { eliminated: null, guides };
  const circle = circleOf(P);
  guides.push({ type: "circle", center: { lat: P.lat, lng: P.lng }, radius: R });

  // Keep = closest-to-P region ∩ its radius. With a single candidate the whole
  // area is P's cell, so keep is just the area ∩ circle.
  let cell = gameArea;
  if (features.length >= 2) {
    const { cells } = voronoiCells(features, gameArea);
    for (const c of cells) if (c) for (const ring of geojsonRings(c)) guides.push({ type: "outline", ring });
    // If P's cell couldn't be resolved (a null Voronoi cell), don't fall back to
    // the full game area — that would keep the whole circle, including area that
    // is actually closer to another listed place. Return null instead of guessing.
    cell = cells[featureIndex];
    if (!cell) return { eliminated: null, guides };
  }
  const keepRegion = safeIntersect(cell, circle.geometry);
  if (!keepRegion) return { eliminated: null, guides };
  const eliminated = safeDiff(gameArea, keepRegion);
  return { eliminated, guides };
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
  const { refType, refGeometry, refFeatures, ring, distance } = step.inputs;
  const side = step.answer?.side; // "in" (within/closer) | "out" (beyond/farther)
  const guides = [];

  // Region mode (Sea Level): elevation can't be derived from map geometry, so the
  // hider's revealed level is drawn as a region and we simply keep that side — no
  // distance buffer. answer.inside === false keeps the outside instead.
  if (refType === "region") {
    if (ring) guides.push({ type: "outline", ring: ring.map(([lat, lng]) => ({ lat, lng })) });
    const inside = step.answer?.inside !== false;
    return { eliminated: keepRegionSide(gameArea, ring, inside), guides };
  }

  // Reference visuals for the buffer modes (points / line / area).
  if (refGeometry?.type === "LineString") guides.push({ type: "polyline", coords: refGeometry.coordinates.map(([lng, lat]) => ({ lat, lng })) });
  if (refGeometry?.type === "Polygon") for (const r of geojsonRings(refGeometry)) guides.push({ type: "outline", ring: r });
  for (const f of refFeatures || []) guides.push({ type: "point", lat: f.lat, lng: f.lng });

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
export function computeActiveArea(gameArea, steps) {
  if (!gameArea) return null;
  const elims = [];
  for (const s of steps || []) {
    if (!s.enabled) continue;
    const { eliminated } = computeElimination(s, gameArea);
    if (eliminated) elims.push(eliminated);
  }
  if (!elims.length) return gameArea;
  let removed = elims[0];
  for (let i = 1; i < elims.length; i++) removed = safeUnion(removed, elims[i]) || removed;
  return safeDiff(gameArea, removed);
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
    if (mode === "nameLength") return `Matching · station name length ${step.answer?.length}`;
    if (mode === "region") return `Matching · ${cat} · ${step.answer?.inside === false ? "outside" : "inside"}`;
    if (mode === "nearestLine") {
      const ln = (step.inputs.lines || []).find((l) => l.id === step.answer?.lineId);
      return `Matching · ${cat} · “${ln?.label || "?"}”`;
    }
    const sel = (step.inputs.features || [])[step.answer?.featureIndex];
    return `Matching · ${cat} · “${sel?.name || "?"}”`;
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
