// Truthful-answer oracle (v2 Phase 1, item C).
//
// Given a step and a KNOWN hider position, derive the answer a truthful hider would
// give. This is deliberately NOT a play feature — the app answers questions manually
// and `IMPROVEMENTS.md` is explicit that auto-answer was tried and removed. What this
// exists for is the property nobody was checking:
//
//     fold every truthfully-answered question and the hider must still be inside
//     the surviving area.
//
// That is the one guarantee the whole app rests on, and until now nothing asserted it.
// The reference mapper (taibeled/JetLagHideAndSeek) gets this for free because it ships
// a hider mode; we get it as a test harness instead, which is the better trade — see
// MAPPER_ANALYSIS §10.6.
//
// Secondary use: a POST-GAME debrief ("did we ever eliminate the square they were
// actually standing in?"). Never wire this into live answering.
//
// Every function here is pure and DOM-free so `node --test` can drive it.

import { distanceToGeometryM, distanceToLinePathsM, metresBetween } from "./geo.js";
import { computeActiveArea, EMPTY_AREA, linePaths } from "./tools.js";

function T() {
  if (!window.turf) throw new Error("Turf.js not loaded.");
  return window.turf;
}
function feat(g) {
  return g && g.type === "Feature" ? g : T().feature(g);
}
const pt = (p) => T().point([p.lng, p.lat]);

// The distance primitives live in geo.js, shared with the measuring cards (item F) — the
// oracle must judge "closer than me?" by exactly the same measure the app buffers by, or
// it is grading the app against a different question. `metresBetween` is geo.js's
// equirectangular-lite helper, which is also what the Voronoi's longitude compression
// approximates, so the oracle and the partition agree by construction rather than by luck.
export { distanceToGeometryM, metresBetween };

// Metres from a point to the nearest path of a line object (hand-drawn `coords` or
// auto-sourced `paths` — `linePaths` normalises both).
export function distanceToLineM(p, ln) {
  return distanceToLinePathsM(p, linePaths(ln));
}

// Index of the nearest entry in a {lat,lng}[] feature list.
function nearestFeatureIndex(p, features) {
  let best = -1, bestD = Infinity;
  (features || []).forEach((f, i) => {
    const d = metresBetween(p, f);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

// Index of the nearest line.
function nearestLineIndex(p, lines) {
  let best = -1, bestD = Infinity;
  (lines || []).forEach((ln, i) => {
    const d = distanceToLineM(p, ln);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function pointInRing(p, ring) {
  if (!ring || ring.length < 3) return false;
  // Rings are stored [lat,lng] (map order); turf wants [lng,lat].
  const coords = ring.map(([lat, lng]) => [lng, lat]);
  const a = coords[0], b = coords[coords.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) coords.push([a[0], a[1]]);
  return T().booleanPointInPolygon(pt(p), T().polygon([coords]));
}

/**
 * The answer a truthful hider at `hider` would give to `step`.
 *
 * Returns a NEW answer object; the step is not mutated. Fields the SEEKER chose
 * (which candidate they picked, what their own distance was) are carried through
 * unchanged — the hider does not get to reselect them, they only answer.
 *
 * Returns null when the step cannot be answered as posed (no candidates, no
 * reference geometry, an unknown tool). Callers must treat null as "skip", never
 * as a default answer — guessing here would defeat the point of the harness.
 */
export function truthfulAnswer(step, hider, gameArea) {
  if (!step || !hider) return null;
  const inputs = step.inputs || {};
  const prior = step.answer || {};

  switch (step.tool) {
    case "radar": {
      const { center, radius } = inputs;
      if (!center || radius == null) return null;
      return { side: metresBetween(hider, center) <= radius ? "in" : "out" };
    }

    case "thermometer": {
      const { a, b } = inputs;
      if (!a || !b) return null;
      // "hotter" == closer to B, the end the seeker travelled toward.
      return { side: metresBetween(hider, b) < metresBetween(hider, a) ? "hotter" : "colder" };
    }

    case "matching": {
      switch (inputs.mode) {
        case "region":
          return { inside: pointInRing(hider, inputs.ring) };

        case "nameLength": {
          const { features } = inputs;
          if (!features?.length || prior.length == null) return null;
          const i = nearestFeatureIndex(hider, features);
          if (i < 0) return null;
          const len = features[i].len;
          // The seeker's own name-length stays; the hider only reports how theirs compares.
          // v2 Phase 5 (item K): answer in the ternary form, since a truthful hider knows
          // which way it differs and saying so costs them nothing. `match` is still emitted
          // so an older reader of this answer keeps working.
          const comparison = len === prior.length ? "same" : len < prior.length ? "shorter" : "longer";
          return { length: prior.length, comparison, match: comparison === "same" };
        }

        // v2 Phase 5 (item J). Membership, not proximity: the hider's NEAREST STATION either
        // is or is not one of the stations served by the seeker's line. Deliberately computed
        // from the station list rather than from the zones, because that is the question the
        // hider is actually answering — the zones are only how the answer becomes an area.
        case "stationLine": {
          const { stations, memberIds } = inputs;
          if (!stations?.length || !Array.isArray(memberIds)) return null;
          const i = nearestFeatureIndex(hider, stations);
          if (i < 0) return null;
          return { match: memberIds.includes(stations[i].id) };
        }

        case "nearestLine": {
          const { lines } = inputs;
          if (!lines?.length || prior.lineId == null) return null;
          const i = nearestLineIndex(hider, lines);
          if (i < 0) return null;
          return { lineId: prior.lineId, match: lines[i].id === prior.lineId };
        }

        default: { // "nearest"
          const { features } = inputs;
          if (!features?.length || prior.featureIndex == null) return null;
          const i = nearestFeatureIndex(hider, features);
          if (i < 0) return null;
          return { featureIndex: prior.featureIndex, keep: i === prior.featureIndex };
        }
      }
    }

    case "tentacles": {
      const { features, lines, radius, center } = inputs;
      const isLines = Array.isArray(lines) && lines.length > 0;
      const items = isLines ? lines : features;
      if (!items?.length) return null;

      // Seeker-centric model: out of reach is a legitimate answer and must be reported
      // as a MISS, not as "nearest to whichever is least far".
      if (center && radius != null && metresBetween(hider, center) > radius) {
        return { none: true };
      }
      const i = isLines ? nearestLineIndex(hider, lines) : nearestFeatureIndex(hider, features);
      if (i < 0) return null;

      // Legacy per-POI-circle steps (no `center`): the miss condition is being outside
      // EVERY candidate's circle, not outside the seeker's.
      if (!center && radius != null) {
        const d = isLines ? distanceToLineM(hider, lines[i]) : metresBetween(hider, features[i]);
        if (d > radius) return { none: true };
      }
      return { featureIndex: i };
    }

    case "measuring": {
      if (inputs.refType === "region") return { inside: pointInRing(hider, inputs.ring) };
      const { refGeometry, distance } = inputs;
      if (!refGeometry || distance == null) return null;
      // "in" == the hider is within the seeker's own distance of the reference.
      return { side: distanceToGeometryM(hider, refGeometry) <= distance ? "in" : "out" };
    }

    default:
      return null;
  }
}

/**
 * Answer every step in `history` truthfully for a hider at `hider`.
 * Steps the oracle cannot answer are returned unchanged and listed in `skipped`.
 */
export function answerAllTruthfully(history, hider, gameArea) {
  const skipped = [];
  const steps = (history || []).map((s) => {
    const answer = truthfulAnswer(s, hider, gameArea);
    if (!answer) { skipped.push(s.id); return s; }
    return { ...s, answer };
  });
  return { steps, skipped };
}

/**
 * The property the whole app rests on.
 *
 * Fold every truthfully-answered enabled step and report whether the hider survived.
 * `retained: false` means the app would have eliminated the square the hider was
 * actually standing in — a false elimination, the one failure mode that loses a game
 * outright rather than merely costing a turn.
 */
export function verifyHiderRetained(gameArea, history, hider) {
  const { steps, skipped } = answerAllTruthfully(history, hider, gameArea);
  const failures = [];
  const active = computeActiveArea(gameArea, steps, (id, reason) => failures.push({ id, reason }));

  if (active === EMPTY_AREA) {
    return { retained: false, reason: "empty-area", active, steps, skipped, failures };
  }
  if (!active) {
    return { retained: false, reason: "no-active-area", active, steps, skipped, failures };
  }
  const retained = T().booleanPointInPolygon(pt(hider), feat(active));
  return {
    retained,
    reason: retained ? null : "hider-eliminated",
    active,
    steps,
    skipped,
    failures,
  };
}
