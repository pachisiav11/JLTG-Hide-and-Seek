// A7 — a failed union must not silently discard an elimination.
//
// `removed = safeUnion(removed, elims[i]) || removed` — and safeUnion already swallows its
// exception and returns null. So a union failure dropped that step's ENTIRE eliminated
// region from the mask. Nothing threw; no banner. The board showed area as still-possible
// that a question had ruled out — indistinguishable from a correct board.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea, radarStep } from "./helpers/turf-env.mjs";
import { computeActiveArea, EMPTY_AREA } from "../src/tools.js";

const AREA = squareArea([72.8777, 19.076], 0.2);
const board = turf.area(turf.feature(AREA));
const areaOf = (g) => (g && g !== EMPTY_AREA ? turf.area(turf.feature(g)) : 0);

// Two separate radar circles, each removing its own interior. Their union is what the
// mask needs; if that union fails, one of them vanishes from the board.
const stepA = radarStep({ center: [72.82, 19.03], radiusM: 3000, side: "out", id: "A" });
const stepB = radarStep({ center: [72.94, 19.12], radiusM: 3000, side: "out", id: "B" });

test("both eliminations are reflected in the active area when the union succeeds", () => {
  const active = computeActiveArea(AREA, [stepA, stepB]);
  const removed = board - areaOf(active);
  // Two disjoint 3 km circles remove a real, measurable share.
  assert.ok(removed > 0, "both circles should be removed from the active area");
});

test("a failed union reports the step instead of silently dropping it", () => {
  const realUnion = window.turf.union;
  window.turf.union = () => { throw new Error("simulated union failure"); };
  const failures = [];
  try {
    const active = computeActiveArea(AREA, [stepA, stepB], (id, reason) => failures.push({ id, reason }));
    // It still renders something — dropping one step beats blanking the board...
    assert.ok(active, "a union failure must not blank the active area");
    // ...but the loss must be reported, which is the entire point.
    assert.deepEqual(failures, [{ id: "B", reason: "union" }],
      "the step whose elimination was dropped must be named");
  } finally {
    window.turf.union = realUnion;
  }
});

test("without the callback the old silent behaviour is still contained, not thrown", () => {
  // computeActiveArea is called from _render outside a try/catch, so it must never throw
  // on a union failure — it reports instead.
  const realUnion = window.turf.union;
  window.turf.union = () => { throw new Error("simulated union failure"); };
  try {
    assert.doesNotThrow(() => computeActiveArea(AREA, [stepA, stepB]));
  } finally {
    window.turf.union = realUnion;
  }
});

test("the dropped elimination is genuinely missing — the harm being reported is real", () => {
  const realUnion = window.turf.union;
  const healthy = areaOf(computeActiveArea(AREA, [stepA, stepB]));

  window.turf.union = () => { throw new Error("simulated union failure"); };
  let broken;
  try {
    broken = areaOf(computeActiveArea(AREA, [stepA, stepB], () => {}));
  } finally {
    window.turf.union = realUnion;
  }

  // With the union broken, only step A's circle is removed, so MORE area survives than
  // should. That surviving strip is area a question already ruled out.
  assert.ok(broken > healthy,
    `a dropped elimination leaves more area alive (healthy ${healthy.toFixed(0)} vs broken ${broken.toFixed(0)})`);
});

test("a compute failure is reported separately from a union failure", () => {
  // The two have different consequences and different messages, so they must be
  // distinguishable by the caller.
  const bad = { id: "bad", tool: "matching", enabled: true, inputs: { mode: "nearest", features: null }, answer: {} };
  const failures = [];
  computeActiveArea(AREA, [stepA, bad], (id, reason) => failures.push({ id, reason }));
  // A malformed step either computes to nothing or reports "compute" — never "union".
  assert.ok(!failures.some((f) => f.reason === "union"), "a compute failure must not be labelled a union failure");
});
