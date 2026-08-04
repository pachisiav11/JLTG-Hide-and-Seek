// Hiding zones (v2 Phase 3, item L).
//
// The reference mapper's best idea, and the one this codebase was already closest to having.
// A seeker does not actually want to reason about "3,200 km² of shading" — they want to
// reason about "nine stations left". This module is the bridge between the two.
//
// THE CORRECTNESS POINT, which is the real reason this exists:
//
// A station's elimination was decided by `countStationsInEliminated` with a point-in-polygon
// test — the station counts as ruled out when its exact coordinate falls inside the eliminated
// region. That is only right if the hider must be standing precisely ON the station. In the
// game they are hiding WITHIN some radius of it, and under that rule a station whose point is
// eliminated but whose surrounding zone is partly untouched gets ruled out while the hider is
// standing in the part that survived. That is a false elimination: the failure mode that loses
// a game outright rather than costing a turn.
//
// The zone rule is the safe one and it is also simply the correct model of the game:
//
//     a station survives  <=>  ANY part of its zone survives
//
// With radius 0 the zone collapses to the point and the rule degenerates to the old
// behaviour exactly, which is why 0 is the default: existing boards do not silently change
// under a seeker mid-game. A non-zero radius is the game-accurate setting.
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
 * Does any part of this station's zone survive inside `activeArea`?
 *
 * `activeArea` is the region still possible (game area minus every elimination). A null
 * activeArea means nothing survives anywhere, so neither does the zone.
 *
 * Errors resolve to TRUE (survives). A station we cannot decide about must not be ruled out
 * — under-eliminating costs a turn, and the whole point of this module is to stop doing the
 * other thing.
 */
export function zoneSurvives(activeArea, station, radiusM) {
  const turf = T();
  if (!turf) return true;
  if (!activeArea) return false;
  const lng = Number(station?.lng), lat = Number(station?.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return true;

  try {
    const area = activeArea.type === "Feature" ? activeArea : turf.feature(activeArea);
    // Radius 0 (or unset) is the degenerate zone: the old point test, unchanged.
    if (!Number.isFinite(radiusM) || radiusM <= 0) {
      return turf.booleanPointInPolygon(turf.point([lng, lat]), area);
    }
    // The station's own point surviving is sufficient and is the common case, so check the
    // cheap test first and only build a circle when it fails.
    if (turf.booleanPointInPolygon(turf.point([lng, lat]), area)) return true;

    const zone = zoneFor(station, radiusM);
    if (!zone) return true;
    // booleanIntersects is the right predicate: we need "shares ANY ground", not "is
    // contained by". An intersect-and-measure-area would also work but allocates a polygon
    // per station on every render, and this runs over the whole station list.
    return turf.booleanIntersects(zone, area);
  } catch (_) {
    return true; // undecidable => keep it, see above
  }
}

/**
 * Split a station list by whether its hiding zone still survives.
 *
 * Stations the seeker has already eliminated by hand stay eliminated — a manual call is an
 * observation ("we searched there"), not a geometric deduction, and the geometry must not
 * resurrect it. That asymmetry is deliberate and is the same one `countStationsInEliminated`
 * already had.
 */
export function splitByZoneSurvival(activeArea, stations, radiusM) {
  const surviving = [], eliminated = [], manual = [];
  for (const s of stations || []) {
    if (s?.eliminated) { manual.push(s); continue; }
    if (zoneSurvives(activeArea, s, radiusM)) surviving.push(s);
    else eliminated.push(s);
  }
  return { surviving, eliminated, manual };
}

/**
 * How many still-live stations a PROPOSED elimination would rule out, under zone semantics.
 *
 * Mirrors `countStationsInEliminated`'s contract — `{ inside, total }`, or null when there is
 * nothing meaningful to count — so it can stand in for it at the call site. The difference is
 * the rule: a station counts as ruled out only when its WHOLE zone falls inside the proposed
 * region, not merely its centre point.
 *
 * `activeArea` is optional and is what makes the count honest on a board that already has
 * questions on it: a station whose zone only survives outside the current active area was
 * already gone, and counting it again would tell the seeker a question is doing more work
 * than it is.
 */
export function countStationsEliminatedByZone(proposed, stations, radiusM, activeArea = null) {
  const turf = T();
  if (!proposed || !Array.isArray(stations) || !stations.length || !turf) return null;

  let shape;
  try { shape = proposed.type === "Feature" ? proposed : turf.feature(proposed); }
  catch (_) { return null; }

  let inside = 0, total = 0;
  for (const s of stations) {
    if (s?.eliminated) continue;
    // Already ruled out by the questions on the board: not this question's doing.
    if (activeArea && !zoneSurvives(activeArea, s, radiusM)) continue;
    total++;
    // "Would be eliminated" == no part of the zone survives OUTSIDE the proposed region,
    // which is the same test as zoneSurvives against the complement. Expressed directly:
    // the zone is fully contained by the proposed elimination.
    try {
      const lng = Number(s.lng), lat = Number(s.lat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      if (!Number.isFinite(radiusM) || radiusM <= 0) {
        if (turf.booleanPointInPolygon(turf.point([lng, lat]), shape)) inside++;
        continue;
      }
      const zone = zoneFor(s, radiusM);
      if (!zone) continue;
      // booleanContains(shape, zone) is the exact question and avoids materialising a
      // difference polygon per station.
      if (turf.booleanContains(shape, zone)) inside++;
    } catch (_) { /* undecidable: leave it counted as surviving */ }
  }
  if (total === 0) return null;
  return { inside, total };
}

/**
 * Per-zone drill-down (item N): "if the hider is at THIS station, what does the board say?"
 *
 * Answers the question a seeker actually asks late in a game, when the shading has stopped
 * being the useful representation and the real question is which of six remaining stations to
 * drive to. For one station it reports:
 *
 *   - does any of its zone survive, and how much of it
 *   - which enabled questions rule the zone out, individually
 *
 * That second list is the valuable half and it is not derivable from the map: a zone can be
 * eliminated by the *combination* of two questions while neither rules it out alone, and the
 * shading cannot show that. Naming the questions that do the work tells the seeker which
 * answer to double-check if a station they were confident about disappears.
 *
 * `eliminationFor(step)` is injected rather than imported so this module stays free of
 * tools.js (which would be a cycle) and so tests can drive it without geometry.
 */
export function zoneDiagnosis(gameArea, steps, station, radiusM, eliminationFor) {
  const turf = T();
  if (!turf || !gameArea || !station) return null;

  const zone = zoneFor(station, radiusM);
  const zoneGeom = zone ? zone : null;
  const zoneArea = zoneGeom ? turf.area(zoneGeom) : 0;

  // Clipped to the board first: zone area outside the play area was never available, and
  // counting it would understate how much of the zone the questions actually removed.
  let remaining = null;
  try {
    remaining = zoneGeom
      ? turf.intersect(turf.featureCollection([zoneGeom, turf.feature(gameArea)]))
      : null;
  } catch (_) { remaining = null; }

  const onBoardArea = remaining ? turf.area(remaining) : 0;
  const culprits = [];

  for (const s of steps || []) {
    if (!s?.enabled || s.draft) continue;
    let elim = null;
    try { elim = eliminationFor(s); } catch (_) { continue; } // a broken step is reported elsewhere
    if (!elim) continue;

    const before = remaining;
    try {
      remaining = remaining
        ? turf.difference(turf.featureCollection([remaining, turf.feature(elim)]))
        : null;
    } catch (_) { remaining = before; continue; }

    const after = remaining ? turf.area(remaining) : 0;
    const beforeArea = before ? turf.area(before) : 0;
    // Only report a question that actually took ground off THIS zone. A question that
    // eliminated half the board but nothing here is not why this station is gone.
    if (beforeArea - after > Math.max(1, beforeArea * 1e-6)) {
      culprits.push({ id: s.id, tool: s.tool, removedM2: beforeArea - after, fatal: after === 0 });
    }
    if (!remaining) break;
  }

  const survivingArea = remaining ? turf.area(remaining) : 0;
  return {
    station: { id: station.id, name: station.name },
    survives: survivingArea > 0,
    // Fraction of the zone's ON-BOARD area that is still possible. `null` when the zone never
    // overlapped the board at all, which is a different thing from "eliminated" and must not
    // be reported as 0%.
    fraction: onBoardArea > 0 ? survivingArea / onBoardArea : null,
    zoneAreaM2: zoneArea,
    onBoardAreaM2: onBoardArea,
    survivingAreaM2: survivingArea,
    culprits,
  };
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
