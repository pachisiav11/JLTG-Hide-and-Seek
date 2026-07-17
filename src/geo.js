// Geometry + coordinate helpers.
// Game polygons are stored as [[lat, lng], ...] (guide §4). GeoJSON and Turf use
// [lng, lat]. This module centralizes every conversion so the rest of the app
// never has to think about axis order.

function T() {
  if (!window.turf) throw new Error("Turf.js not loaded.");
  return window.turf;
}

// Bound a candidate feature set to the neighbourhood of `area` WITHOUT dropping legitimate
// partition seeds.
//
// This replaces a containment filter that kept only features inside the play area, on the
// reasoning that the hider is in the zone so outside places "could never be nearest". That
// is backwards. A POI outside the board can genuinely be the nearest to a hider near the
// boundary — a city board whose nearest Commercial Airport lies 30 km beyond the edge is
// the ordinary case, not an edge case. Dropping that seed makes the surviving seeds'
// Voronoi cells LARGER than the true cells, so a "No — different" answer eliminates an
// oversized region: the area where the hider actually is.
//
// Seeds outside the board are harmless — voronoiCells clips the resulting CELLS to the game
// area, so an outside seed contributes only by correctly shrinking its neighbours. The pad
// here is a sanity bound on a large Overpass return, never a correctness filter, so it is
// deliberately generous: a full board-span (min ~0.5°, ~55 km) on every side.
export function featuresNearArea(feats, area) {
  if (!area || !window.turf || !Array.isArray(feats)) return feats;
  try {
    const bb = T().bbox(T().feature(area)); // [minLng,minLat,maxLng,maxLat]
    const padX = Math.max(bb[2] - bb[0], 0.5);
    const padY = Math.max(bb[3] - bb[1], 0.5);
    return feats.filter((f) =>
      f.lng >= bb[0] - padX && f.lng <= bb[2] + padX &&
      f.lat >= bb[1] - padY && f.lat <= bb[3] + padY);
  } catch (_) { return feats; } // never block on a geometry error
}

// [[lat,lng],...] ring -> Turf polygon feature (auto-closed).
export function ringToTurf(latlngs) {
  const ring = latlngs.map(([lat, lng]) => [lng, lat]);
  if (ring.length) {
    const a = ring[0], b = ring[ring.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]);
  }
  return T().polygon([ring]);
}

// Self-intersections in a hand-drawn ring (D1). Returns how many turf.kinks finds on the
// CLOSED ring, so the implicit last->first edge is checked too — that edge is invisible while
// drawing and is the one a bowtie usually crosses on.
//
// This is worth a guard because a self-crossing ring does NOT fail loudly. Measured on a
// bowtie (2026-07-17):
//   - as a Measuring reference: turf.buffer does not throw, it returns a Polygon, and the
//     step eliminates 409 km2 where the intended square eliminates 304 km2 — a confident,
//     plausible, wrong answer.
//   - as a ZONE: unionRings returns a valid Polygon of AREA 0, so the board silently has no
//     area at all. Nothing throws; the map just stops meaning anything.
// turf.area returns 0 for a bowtie because the two lobes wind opposite ways and cancel, which
// is why an area check alone can't tell a bowtie from a legitimately tiny zone.
export function ringSelfIntersections(latlngs) {
  if (!Array.isArray(latlngs) || latlngs.length < 3) return 0;
  try {
    return T().kinks(ringToTurf(latlngs)).features.length;
  } catch (_) {
    return 0; // a ring turf can't even read is not a KINK problem; let the caller's guards have it
  }
}

// Google Maps path (MVCArray of LatLng) -> [[lat,lng],...].
export function pathToRing(path) {
  const out = [];
  path.forEach((ll) => out.push([ll.lat(), ll.lng()]));
  return out;
}

// GeoJSON Polygon/MultiPolygon geometry -> array of Google paths ([{lat,lng},...]).
// Flattens every ring to its own path — use only when holes don't matter.
export function geojsonToPaths(geom) {
  if (!geom) return [];
  let polys = [];
  if (geom.type === "MultiPolygon") polys = geom.coordinates;
  else if (geom.type === "Polygon") polys = [geom.coordinates];
  const paths = [];
  for (const poly of polys) {
    for (const ring of poly) {
      paths.push(ring.map(([lng, lat]) => ({ lat, lng })));
    }
  }
  return paths;
}

// GeoJSON Polygon/MultiPolygon -> array of path GROUPS, one per polygon, each a
// [outerRing, ...holeRings] of [{lat,lng}]. Pass a group as a single Google Maps
// Polygon `paths` so inner rings render as real HOLES (even-odd fill) rather than
// separate filled shapes. Required for inverse "mask everything but X" overlays.
export function geojsonToPathGroups(geom) {
  if (!geom) return [];
  let polys = [];
  if (geom.type === "MultiPolygon") polys = geom.coordinates;
  else if (geom.type === "Polygon") polys = [geom.coordinates];
  return polys.map((poly) => poly.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))));
}

// Union of many [[lat,lng]] rings -> single GeoJSON geometry (Polygon/MultiPolygon), or null.
export function unionRings(rings) {
  const polys = (rings || []).filter((r) => r && r.length >= 3).map(ringToTurf);
  if (!polys.length) return null;
  if (polys.length === 1) return polys[0].geometry;
  try {
    const u = T().union(T().featureCollection(polys));
    return u ? u.geometry : null;
  } catch (e) {
    console.warn("union failed", e);
    return null;
  }
}

// Parse pasted zone input: a GeoJSON Feature/FeatureCollection/geometry, OR a raw
// coordinate list. Returns an array of { name, ring:[[lat,lng],...] }.
export function parseZoneInput(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];
  // Try GeoJSON first.
  try {
    const obj = JSON.parse(trimmed);
    return geojsonToZones(obj);
  } catch (_) {
    // Fall through to coordinate parsing.
  }
  const ring = parseCoordList(trimmed);
  return ring.length >= 3 ? [{ name: "", ring }] : [];
}

function geojsonToZones(obj) {
  const zones = [];
  const pushGeom = (geom, name) => {
    for (const path of geojsonToPaths(geom)) {
      const ring = path.map((p) => [p.lat, p.lng]);
      // Drop the closing duplicate vertex for storage.
      if (ring.length > 1) {
        const a = ring[0], b = ring[ring.length - 1];
        if (a[0] === b[0] && a[1] === b[1]) ring.pop();
      }
      if (ring.length >= 3) zones.push({ name: name || "", ring });
    }
  };
  if (obj.type === "FeatureCollection") {
    for (const f of obj.features || []) pushGeom(f.geometry, f.properties?.name);
  } else if (obj.type === "Feature") {
    pushGeom(obj.geometry, obj.properties?.name);
  } else if (obj.type === "Polygon" || obj.type === "MultiPolygon") {
    pushGeom(obj, "");
  }
  return zones;
}

// Accept "lat,lng lat,lng" or "lat,lng; lat,lng" or newline-separated pairs.
function parseCoordList(text) {
  const nums = text.split(/[;\n]|\)\s*,?\s*\(|\s{2,}/).map((s) => s.trim()).filter(Boolean);
  const pairs = [];
  for (const chunk of nums) {
    const m = chunk.match(/-?\d+(\.\d+)?/g);
    if (m && m.length >= 2) pairs.push([parseFloat(m[0]), parseFloat(m[1])]);
  }
  return pairs;
}

// A sanity-check size hint for an assembled game area (Phase 7): its area plus a
// coarse Small/Medium/Large/Very large tier, so a mis-sized play area is obvious
// before questions are added. Thresholds are in km² (≈ 50 / 500 / 5000 sq mi), so
// "~450 sq mi" reads as Medium. Returns { m2, tier, sizeTxt, text } or null.
export function areaSummary(geom, units = "metric") {
  if (!geom || !window.turf) return null;
  let m2;
  try { m2 = T().area(feat(geom)); } catch (_) { return null; }
  const km2 = m2 / 1e6;
  const tier = km2 < 130 ? "Small" : km2 < 1300 ? "Medium" : km2 < 13000 ? "Large" : "Very large";
  const fmt = (n) => n.toLocaleString(undefined, { maximumFractionDigits: n >= 10 ? 0 : n >= 1 ? 1 : 2 });
  const sizeTxt = units === "imperial"
    ? `${fmt(m2 / 2.589988e6)} sq mi`
    : `${fmt(km2)} km²`;
  return { m2, tier, sizeTxt, text: `≈ ${sizeTxt} · ${tier}` };
}

// turf.feature() wrapper local to this module (geojsonToPaths etc. don't need it).
function feat(g) {
  return g && g.type === "Feature" ? g : T().feature(g);
}

export function centroidOfRing(ring) {
  try {
    const c = T().centroid(ringToTurf(ring));
    const [lng, lat] = c.geometry.coordinates;
    return { lat, lng };
  } catch (_) {
    return null;
  }
}
