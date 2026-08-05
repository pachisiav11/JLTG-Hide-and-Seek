// Hiding zones — the circles drawn around stations on the map.
//
// A station is a point, but a hider near it is not standing on the point; they are somewhere
// within a walk of it. `settings.hidingRadiusM` (default 0, i.e. off) is that walk, and this
// module turns it into geometry the map can draw: everywhere the hider could plausibly be,
// rather than a dot they are almost certainly not standing on.
//
// SCOPE, after the station-list review — this module is now DISPLAY ONLY.
//
// It used to carry the survival rule too ("a station survives iff ANY part of its zone
// survives"), which existed to stop a station being ruled out while the hider stood in the
// part of its zone that lived. That rule had exactly two consumers — the draft preview's
// "N of M stations would be eliminated" counter, and the per-station "what survives here?"
// drill-down — and both were removed on the owner's call. It never drove an actual
// elimination: stations are only ever eliminated by hand (a tap, a line, a range), which is
// a seeker's observation rather than a geometric deduction. So with its two readouts gone the
// rule had no caller at all, and dead safety code that reads as if it were enforcing
// something is worse than no code. `zoneSurvives`, `splitByZoneSurvival`,
// `countStationsEliminatedByZone` and `zoneDiagnosis` went with it.
//
// What remains is the honest version: a radius, a circle per station, four ways to draw them.
//
// Everything here is pure and DOM-free so `node --test` can drive it.

function T() {
  if (typeof window === "undefined" || !window.turf) return null;
  return window.turf;
}

// Circle steps. 32 is what the reference uses and is plenty: the zone is a fuzzy concept
// ("within about half a mile of the station") and the polygonisation error at 32 steps is
// ~0.6% of the radius — far inside the fuzziness of the concept itself, and far cheaper than
// 64 on a board carrying 300 stations.
const ZONE_STEPS = 32;

/**
 * A station's hiding zone as a turf polygon, or null when there is no radius (the zone is
 * then the point itself and callers use the point test instead).
 */
export function zoneFor(station, radiusM) {
  const turf = T();
  if (!turf || !station || !Number.isFinite(radiusM) || radiusM <= 0) return null;
  const lng = Number(station.lng), lat = Number(station.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  try {
    return turf.circle([lng, lat], radiusM / 1000, { units: "kilometers", steps: ZONE_STEPS });
  } catch (_) {
    return null;
  }
}

/**
 * The zone geometry to draw, in one of four styles (item M).
 *
 *   "zones"      — one circle per surviving station. The default and the most informative.
 *   "stations"   — just the points. Cheapest, and readable when zones overlap heavily.
 *   "no-overlap" — the union of the circles, i.e. the silhouette of everywhere the hider
 *                  could be. On a dense board this is the only readable one, and it is also
 *                  the honest picture: overlapping circles suggest more distinct places than
 *                  actually exist.
 *   "no-display" — nothing on the map; the list still updates.
 *
 * Returns { style, circles, points, union } with only the fields that style needs, so a
 * caller never pays for geometry it will not draw. `union` is null when the union fails —
 * a failed union must not blank the layer, so callers fall back to `circles`.
 */
export function zoneRenderGeometry(stations, radiusM, style = "zones") {
  const turf = T();
  const points = (stations || [])
    .filter((s) => Number.isFinite(Number(s?.lng)) && Number.isFinite(Number(s?.lat)))
    .map((s) => ({ id: s.id, name: s.name, lat: Number(s.lat), lng: Number(s.lng) }));

  if (style === "no-display") return { style, circles: [], points: [], union: null };
  if (style === "stations" || !turf || !Number.isFinite(radiusM) || radiusM <= 0) {
    return { style: "stations", circles: [], points, union: null };
  }

  const circles = points.map((p) => ({ point: p, zone: zoneFor(p, radiusM) })).filter((c) => c.zone);
  if (style !== "no-overlap") return { style, circles, points, union: null };

  let union = null;
  let dropped = 0;
  for (const c of circles) {
    if (!union) { union = c.zone; continue; }
    try {
      const merged = turf.union(turf.featureCollection([union, c.zone]));
      if (merged) union = merged; else dropped++;
    } catch (_) { dropped++; }
  }
  // Same reasoning as `unionAll` in tools.js: keep the last good accumulator rather than
  // restarting from the failing member, and say so. A silhouette missing a few circles
  // under-covers, which is the safe direction; a reset accumulator would draw the wrong
  // shape entirely.
  if (dropped) console.warn(`zoneRenderGeometry: ${dropped} zone(s) could not be merged; the silhouette under-covers`);
  return { style, circles, points, union };
}
