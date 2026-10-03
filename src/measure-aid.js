// The hider's measure aid: how far the hider's own position is from the reference the seekers
// sent (question-ref.js). Distances and inside/outside — never a verdict.
//
// THIS IS A DELIBERATE, SCOPED EXCEPTION to "the companion never answers its own questions"
// (GUIDE.md §6.1, test/no-auto-answer.test.mjs), made by the players after Playtest 2, and its
// limits are the point:
//
//   - It runs ONLY on the hider's phone, ONLY against a reference the seekers explicitly sent,
//     and ONLY from the hider's own GPS fix or a point the hider tapped. It never sees a board,
//     a step, or the seekers' map, and it is not imported by any seeker flow (layers.js).
//   - It returns MEASUREMENTS: metres to each listed place, to each line, inside/outside each
//     region and how far the edge is. It does not compare them with the seekers' side and has
//     no field that could be read as an answer — no "closer", no "same", no chosen index. The
//     hider reads two numbers side by side and says the answer out loud themselves.
//   - Nothing it returns is written anywhere. The seekers still type the hider's answer into
//     their own phone, by hand, as for every other question.
//
// What it fixes is the failure the rule exists to prevent, seen from the other side: in
// Playtest 2 the hider answered against Google's coastline while the seekers had drawn their
// own, and the hider eyeballing the seekers' line on a phone map is exactly the "confident,
// subtly wrong" measurement the rule worries about. A distance to the line both teams are
// actually using removes that guess without taking the answer away from the human.
//
// Needs `window.turf` (the vendored bundle), like geo.js.
import { distanceToGeometryM } from "./geo.js";

function T() {
  if (!window.turf) throw new Error("Turf.js not loaded.");
  return window.turf;
}

const byDistance = (a, b) => a.distanceM - b.distanceM;

// Metres from p to a ring's EDGE, regardless of which side p is on.
function edgeDistanceM(p, ring) {
  const turf = T();
  const coords = ring.map(([lat, lng]) => [lng, lat]);
  coords.push([...coords[0]]);
  return turf.pointToLineDistance(turf.point([p.lng, p.lat]), turf.lineString(coords), { units: "meters" });
}

function insideRing(p, ring) {
  const turf = T();
  const coords = ring.map(([lat, lng]) => [lng, lat]);
  coords.push([...coords[0]]);
  return turf.booleanPointInPolygon(turf.point([p.lng, p.lat]), turf.polygon([coords]));
}

/**
 * Measure `point` ({lat,lng}) against a parsed reference.
 *
 * Returns { pois, lines, polygons, center } — every list sorted nearest-first, every distance in
 * metres. `pois` and `lines` carry the seekers' numbering/ids so the hider can find each one on
 * the map; nothing is chosen for them.
 */
export function measureAgainstRef(ref, point) {
  if (!ref || !point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    throw new Error("No position to measure from.");
  }
  const pois = (ref.pois || []).map((q) => ({
    n: q.n, name: q.name,
    distanceM: distanceToGeometryM(point, { type: "Point", coordinates: [q.lng, q.lat] }),
  })).sort(byDistance);

  const lines = (ref.lines || []).map((l) => ({
    id: l.id, name: l.name,
    distanceM: distanceToGeometryM(point, {
      type: "MultiLineString",
      coordinates: l.paths.map((path) => path.map((c) => [c.lng, c.lat])),
    }),
  })).sort(byDistance);

  const polygons = (ref.polygons || []).map((g) => ({
    role: g.role, name: g.name,
    inside: insideRing(point, g.ring),
    edgeDistanceM: edgeDistanceM(point, g.ring),
  }));

  let center = null;
  if (ref.center) {
    const d = distanceToGeometryM(point, { type: "Point", coordinates: [ref.center.lng, ref.center.lat] });
    center = { distanceM: d, radiusM: ref.radiusM ?? null };
  }
  return { pois, lines, polygons, center };
}
