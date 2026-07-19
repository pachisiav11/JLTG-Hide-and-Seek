// C3-1: computeActiveArea refolded identical eliminations on every render.
//
// Completes the memo chain. Once the per-step eliminations were memoised (C1-4, C2-1) a render
// that changed nothing relevant received the SAME geometry objects as the previous one — and
// the union fold plus the final difference were redone against them anyway. `computeActiveArea`
// runs on every `emit`, and `emit` runs on every `store.update`, so this happened once per drag
// event.
//
// The memo is single-entry and identity-compared IN ORDER. These tests exist mostly to pin the
// cases where it must MISS, because a stale active area is the worst possible bug in this app:
// it is the shaded map the seeker reads the answer off.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { turf, squareArea, radarStep } from "./helpers/turf-env.mjs";
import { computeActiveArea, EMPTY_AREA } from "../src/tools.js";

const AREA = squareArea([72.8777, 19.076], 0.4);
const km2 = (g) => (g && g.type ? turf.area(turf.feature(g)) / 1e6 : 0);

const radar = (id, radiusM, side, enabled = true) => radarStep({ id, radiusM, side, enabled });

test("a repeated call returns the same answer", () => {
  const steps = [radar("s1", 5000, "in")];
  const a = computeActiveArea(AREA, steps);
  const b = computeActiveArea(AREA, steps);
  assert.equal(km2(a).toFixed(6), km2(b).toFixed(6));
});

test("toggling a step off changes the answer — the memo must miss", () => {
  // The second question must actually bite. Two concentric "in" radars would not: a 5 km circle
  // sits entirely inside a 9 km one, so the wider question removes nothing and the two answers
  // are equal for a real reason. "inside 5 km AND outside 3 km" is an annulus, which differs.
  const on = [radar("s1", 5000, "in"), radar("s2", 3000, "out")];
  const withBoth = km2(computeActiveArea(AREA, on));
  const off = [radar("s1", 5000, "in"), radar("s2", 3000, "out", false)];
  const withOne = km2(computeActiveArea(AREA, off));
  assert.ok(withOne > withBoth, `disabling a question must widen the board (${withOne} vs ${withBoth})`);
  // and back again
  const again = km2(computeActiveArea(AREA, on));
  assert.equal(again.toFixed(6), withBoth.toFixed(6), "re-enabling must restore the narrower board");
});

test("changing an answer changes the active area — the memo must miss", () => {
  const inn = km2(computeActiveArea(AREA, [radar("s1", 5000, "in")]));
  const out = km2(computeActiveArea(AREA, [radar("s1", 5000, "out")]));
  assert.ok(Math.abs(inn - out) > 1, `"in" and "out" must not share an entry (${inn} vs ${out})`);
});

test("changing the radius changes the active area — the memo must miss", () => {
  const small = km2(computeActiveArea(AREA, [radar("s1", 3000, "in")]));
  const big = km2(computeActiveArea(AREA, [radar("s1", 9000, "in")]));
  assert.ok(big > small, `a wider radar must leave more board (${big} vs ${small})`);
});

test("a different game area is a different fold", () => {
  const steps = [radar("s1", 5000, "out")];
  const small = squareArea([72.8777, 19.076], 0.2);
  const big = squareArea([72.8777, 19.076], 0.6);
  const a = km2(computeActiveArea(small, steps));
  const b = km2(computeActiveArea(big, steps));
  assert.ok(b > a, `a bigger board must leave more active area (${b} vs ${a})`);
  const aAgain = km2(computeActiveArea(small, steps));
  assert.equal(a.toFixed(6), aAgain.toFixed(6), "the small board's entry was corrupted by the big one");
});

test("adding a step narrows the board even when the earlier ones are unchanged", () => {
  // The exact shape a real game produces: the previous steps' geometry objects are reused from
  // their own memos, so only the list length differs. Comparing only the first N would hit.
  const one = [radar("s1", 9000, "in")];
  const first = km2(computeActiveArea(AREA, one));
  const two = [radar("s1", 9000, "in"), radar("s2", 4000, "out")];
  const second = km2(computeActiveArea(AREA, two));
  assert.ok(second < first, `adding a question must narrow the board (${second} vs ${first})`);
});

test("reordering steps is order-independent, as the set difference requires", () => {
  const a = km2(computeActiveArea(AREA, [radar("s1", 5000, "in"), radar("s2", 9000, "in")]));
  const b = km2(computeActiveArea(AREA, [radar("s2", 9000, "in"), radar("s1", 5000, "in")]));
  assert.equal(a.toFixed(3), b.toFixed(3), "activeArea is a pure set difference");
});

test("an empty board and a fully-eliminated board stay distinguishable", () => {
  // EMPTY_AREA (not null) when everything is eliminated, so the caller shades the whole board
  // rather than falling back and showing a fresh game. The memo must not blur these.
  const none = computeActiveArea(AREA, []);
  assert.equal(km2(none).toFixed(3), km2(AREA).toFixed(3), "no questions leaves the whole board");
  const all = computeActiveArea(AREA, [radar("s1", 100000, "out")]);
  assert.deepEqual(all, EMPTY_AREA, "a radar covering the board eliminates all of it");
  const noneAgain = computeActiveArea(AREA, []);
  assert.equal(km2(noneAgain).toFixed(3), km2(AREA).toFixed(3), "and the empty case still returns the board");
});

test("no game area is still null, memo or not", () => {
  assert.equal(computeActiveArea(null, [radar("s1", 5000, "in")]), null);
});

// ---- onFail must survive a cache hit -------------------------------------------
//
// This is the regression the memo introduced and that these tests exist to prevent. The caller
// does NOT accumulate failures: layers.js:225 resets `this.failedSteps` at the top of every
// render and relies entirely on `onFail` to repopulate it. A memoised render that stayed silent
// would clear the set and never refill it, so a question that genuinely could not be folded into
// the mask would be flagged on the first render and then silently lose its warning on every one
// after — while still being missing from the mask.

test("a step that cannot COMPUTE is reported on every call, hit or miss", () => {
  // The per-step loop runs on every call, so this path was never at risk — pinned so a future
  // optimisation that memoises the loop too cannot quietly break it.
  const bad = { id: "bad", tool: "measuring", enabled: true, answer: { side: "in" },
    inputs: { refType: "line", distance: 1000, refGeometry: { type: "MultiLineString", coordinates: "nonsense" } } };
  const steps = [radar("s1", 5000, "in"), bad];
  const first = []; computeActiveArea(AREA, steps, (id, why) => first.push({ id, why }));
  const second = []; computeActiveArea(AREA, steps, (id, why) => second.push({ id, why }));
  assert.deepEqual(first, [{ id: "bad", why: "compute" }]);
  assert.deepEqual(second, first, "a repeated render must report the same failure");
});

test("the memo records failures so a hit reports what a miss reported", () => {
  // Structural: the entry must carry them, and the hit must replay them.
  const src = readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
  assert.match(src, /failures\.push\(\{ id: elims\[i\]\.id, reason: "union" \}\)/,
    "union failures must be recorded, not only reported");
  assert.match(src, /_activeMemo = \{ gameArea, geoms:[^}]*failures \}/,
    "the memo entry must carry them");
  assert.match(src, /for \(const f of _activeMemo\.failures\) onFail\?\.\(f\.id, f\.reason\)/,
    "a hit must replay them");
});

test("a hit is indistinguishable from a miss to the caller", () => {
  // The contract that makes the memo safe to sit under a render loop: same result, same reports.
  const steps = [radar("s1", 9000, "in"), radar("s2", 4000, "out")];
  const a = []; const ra = computeActiveArea(AREA, steps, (id, why) => a.push({ id, why }));
  const b = []; const rb = computeActiveArea(AREA, steps, (id, why) => b.push({ id, why }));
  assert.equal(km2(ra).toFixed(6), km2(rb).toFixed(6), "same answer");
  assert.deepEqual(b, a, "same reports");
});
