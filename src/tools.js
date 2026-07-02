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

export function computeElimination(step, gameArea) {
  switch (step.tool) {
    case "radar": return radar(step, gameArea);
    case "thermometer": return thermometer(step, gameArea);
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
  return step.tool;
}
