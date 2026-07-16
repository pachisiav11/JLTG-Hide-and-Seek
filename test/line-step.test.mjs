// F2: the nearest-line Voronoi sampled every 400 m regardless of board size.
//
// The headline test is `misassigns a point that is plainly nearer line A`: same lines, same
// probe, two boards. It demonstrates the actual harm (the seeker eliminates the hider's true
// location) rather than asserting a constant, and the large-board case still exercises the
// old 400 m behaviour, so the thing being fixed stays visible instead of being deleted.
import test from "node:test";
import assert from "node:assert/strict";
import { turf } from "./helpers/turf-env.mjs";
import { computeElimination, lineStepMeters, LINE_STEP_MIN_M, LINE_STEP_MAX_M } from "../src/tools.js";

const ORIGIN = [72.8777, 19.076]; // Mumbai-ish; lng compression is real here (cos19° ≈ 0.945)

// Ground-metre offsets via turf.destination — hand-rolled deg-per-metre trig is how test
// geometry has been quietly wrong before.
function offset([lng, lat], northM, eastM) {
  let p = [lng, lat];
  if (northM) p = turf.destination(p, northM / 1000, 0, { units: "kilometers" }).geometry.coordinates;
  if (eastM) p = turf.destination(p, eastM / 1000, 90, { units: "kilometers" }).geometry.coordinates;
  return p;
}
const ll = ([lng, lat]) => ({ lat, lng });

// Axis-aligned board spanning the given ground offsets from ORIGIN.
function board(southM, westM, northM, eastM) {
  const sw = offset(ORIGIN, southM, westM);
  const ne = offset(ORIGIN, northM, eastM);
  return {
    type: "Polygon",
    coordinates: [[[sw[0], sw[1]], [ne[0], sw[1]], [ne[0], ne[1]], [sw[0], ne[1]], [sw[0], sw[1]]]],
  };
}

// Two parallel lines 150 m apart, running north. B is shifted 200 m north so its samples fall
// OUT OF PHASE with A's — which is the whole point: the failure isn't coarse sampling per se,
// it's that a far line's sample can land nearer the probe than the near line's own samples do.
const LINE_A = { id: "a", coords: [ll(offset(ORIGIN, 0, 0)), ll(offset(ORIGIN, 3000, 0))] };
const LINE_B = { id: "b", coords: [ll(offset(ORIGIN, 200, 150)), ll(offset(ORIGIN, 3200, 150))] };

// 60 m east of A, so 90 m west of B: unambiguously nearer A by ground truth.
// Latitude sits midway between A's two coarsest samples (0 m and 3000/7 = 428.6 m).
const PROBE = offset(ORIGIN, 214.3, 60);

const stepFor = (ga) => ({ id: "s1", tool: "matching", enabled: true, inputs: { mode: "nearestLine", lines: [LINE_A, LINE_B] }, answer: { lineId: "a", match: true } });

// match:true keeps A's region, so `eliminated` is everything EXCEPT it. A probe that is truly
// nearest A must therefore NOT be eliminated.
function probeEliminated(gameArea) {
  const { eliminated } = computeElimination(stepFor(gameArea), gameArea);
  assert.ok(eliminated, "expected a real elimination geometry, not null");
  return turf.booleanPointInPolygon(turf.point(PROBE), eliminated);
}

test("ground truth: the probe really is nearer line A than line B", () => {
  const distTo = (line) => turf.pointToLineDistance(turf.point(PROBE), turf.lineString(line.coords.map((c) => [c.lng, c.lat])), { units: "meters" });
  const dA = distTo(LINE_A), dB = distTo(LINE_B);
  assert.ok(dA < dB, `probe should be nearer A (got A=${dA.toFixed(1)}m, B=${dB.toFixed(1)}m)`);
  assert.ok(Math.abs(dA - 60) < 5, `expected ~60m to A, got ${dA.toFixed(1)}m`);
  assert.ok(Math.abs(dB - 90) < 5, `expected ~90m to B, got ${dB.toFixed(1)}m`);
});

test("lineStepMeters scales with the board, and is clamped at both ends", () => {
  // ~4.3 km diagonal -> 1% is ~43 m, comfortably inside the clamp.
  const small = lineStepMeters(board(-500, -500, 3700, 500));
  assert.ok(small > LINE_STEP_MIN_M && small < LINE_STEP_MAX_M, `expected a scaled step, got ${small}`);
  assert.ok(Math.abs(small - 43) < 8, `expected ~43m for a ~4.3km board, got ${small.toFixed(1)}`);

  // A city-block board would scale below the tracing-error floor.
  assert.equal(lineStepMeters(board(-50, -50, 50, 50)), LINE_STEP_MIN_M);

  // A ~99 km board would scale to ~990 m; capped so this is never coarser than the old 400.
  assert.equal(lineStepMeters(board(-30000, -30000, 40000, 40000)), LINE_STEP_MAX_M);
});

test("a small board no longer misassigns a point that is plainly nearer line A", () => {
  assert.equal(probeEliminated(board(-500, -500, 3700, 500)), false,
    "the probe is 60m from A and 90m from B, so keeping A's region must not eliminate it");
});

test("the old fixed 400m step misassigns that same point (why F2 exists)", () => {
  // Identical lines and probe; only the board grows, which pins the step at the 400 m ceiling
  // -- i.e. exactly the old behaviour. B's out-of-phase sample lands 91m from the probe while
  // A's nearest sample is 222m away, so the probe is handed to B and the seeker eliminates
  // the hider's true location. This is the bug, still reproducible.
  assert.equal(probeEliminated(board(-30000, -30000, 40000, 40000)), true,
    "expected the 400m step to still misassign the probe; if this now passes, the sampling changed");
});
