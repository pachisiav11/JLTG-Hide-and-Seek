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

// --- Voronoi cells shared by Matching & Tentacles ------------------------
// Returns { cells } where cells[i] is the clipped Voronoi cell geometry for
// features[i] (or null). The partition is computed over a bbox that contains both
// the features and the game area, then each cell is clipped to the game area.
function voronoiCells(features, gameArea) {
  const pts = features.map((f) => T().point([f.lng, f.lat]));
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

// Matching & Tentacles: keep OR shade the selected feature's cell.
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
  const { refGeometry, refFeatures, distance } = step.inputs;
  const side = step.answer?.side; // "in" (within/closer) | "out" (beyond/farther)
  const guides = [];
  // Reference visuals.
  if (refGeometry?.type === "LineString") guides.push({ type: "polyline", coords: refGeometry.coordinates.map(([lng, lat]) => ({ lat, lng })) });
  for (const f of refFeatures || []) guides.push({ type: "point", lat: f.lat, lng: f.lng });

  const buffer = refGeometry ? bufferGeometry(refGeometry, distance) : null;
  if (!buffer || !gameArea) return { eliminated: null, guides };
  for (const ring of geojsonRings(buffer)) guides.push({ type: "outline", ring });

  const eliminated = side === "in" ? safeDiff(gameArea, buffer) : safeIntersect(buffer, gameArea);
  return { eliminated, guides };
}

export function computeElimination(step, gameArea) {
  switch (step.tool) {
    case "radar": return radar(step, gameArea);
    case "thermometer": return thermometer(step, gameArea);
    case "matching":
    case "tentacles": return voronoiTool(step, gameArea);
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

// --- Auto-answer from the hider lock (guide §6.1) ------------------------
// Given a tool's inputs and the locked hider point, compute what the true answer
// must be, so the hider's device (or testing) can auto-fill it.
function refDistanceMeters(geom, lock) {
  const L = [lock.lng, lock.lat];
  if (!geom) return Infinity;
  if (geom.type === "MultiPoint") return Math.min(...geom.coordinates.map((c) => T().distance(L, c, { units: "meters" })));
  if (geom.type === "Point") return T().distance(L, geom.coordinates, { units: "meters" });
  if (geom.type === "LineString") return T().pointToLineDistance(T().point(L), T().lineString(geom.coordinates), { units: "meters" });
  return Infinity;
}

export function autoAnswer(tool, inputs, lock) {
  const L = [lock.lng, lock.lat];
  const dist = (p) => T().distance(L, [p.lng, p.lat], { units: "meters" });
  if (tool === "radar") return { side: dist(inputs.center) <= inputs.radius ? "in" : "out" };
  if (tool === "thermometer") return { side: dist(inputs.b) < dist(inputs.a) ? "hotter" : "colder" };
  if (tool === "matching" || tool === "tentacles") {
    let best = 0, bd = Infinity;
    (inputs.features || []).forEach((f, i) => { const d = dist(f); if (d < bd) { bd = d; best = i; } });
    return { featureIndex: best, keep: true };
  }
  if (tool === "measuring") return { side: refDistanceMeters(inputs.refGeometry, lock) <= inputs.distance ? "in" : "out" };
  return {};
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
  if (step.tool === "matching" || step.tool === "tentacles") {
    const feats = step.inputs.features || [];
    const sel = feats[step.answer?.featureIndex];
    const cat = step.inputs.categoryLabel || step.inputs.category || "feature";
    const label = step.tool === "matching" ? "Matching" : "Tentacles";
    const verb = step.answer?.keep ? "keep" : "shade";
    return `${label} · ${cat} · ${verb} “${sel?.name || "?"}”`;
  }
  if (step.tool === "measuring") {
    const d = step.inputs.distance;
    const dTxt = d >= 1000 ? `${(d / 1000).toFixed(d % 1000 ? 1 : 0)} km` : `${Math.round(d)} m`;
    const rel = step.answer?.side === "in" ? "within" : "beyond";
    return `Measuring · ${rel} ${dTxt} of ${step.inputs.refLabel || "reference"}`;
  }
  return step.tool;
}
