// v2 Phase 1, item A — a failed question must never look like an applied question.
//
// This is the single most consequential bug class in this kind of tool, and it is a CLASS,
// not an instance. The shape is always the same: geometry throws, something catches it and
// returns the unmodified area, and the result is indistinguishable from a question that
// legitimately ruled nothing out. The step stays checked, the map looks healthy, and the
// seeker trusts shading that is missing an elimination.
//
// The reference mapper (taibeled/JetLagHideAndSeek) has exactly this bug in its central
// buffer path — MAPPER_ANALYSIS §7.1 measured three radius questions eliminating nothing at
// all, with no error surfaced, because `adjustMapGeoDataForQuestion` wraps the whole fold in
// `try { … } catch { return mapGeoData; }`. We already had most of the defence (`onFail`,
// `failedSteps`, the ⚠ badge); what was missing was that computeActiveArea's "compute"
// reason was reported and then discarded by the only caller.
//
// These tests pin the CONTRACT rather than the wording: every enabled step that fails to
// produce geometry must be reported to `onFail` with a reason, exactly once, and must not be
// confused with a step that computed a null elimination on purpose.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { squareArea, radarStep } from "./helpers/turf-env.mjs";
import { computeActiveArea } from "../src/tools.js";

const BOARD = () => squareArea([72.8777, 19.076], 0.4);

// A step whose tool is real but whose inputs guarantee a throw inside the geometry.
//
// Finding one took a moment, and the reason is a good sign: the obvious candidates DON'T
// fail. Three candidates on one exact coordinate are rescued by `dejitter`, and six exactly
// collinear seeds still partition. Both are asserted below, because "the tool is hard to
// break" is itself worth pinning — if a refactor removes dejitter, that test fails first.
//
// Non-numeric coordinates do fail, in turf's own point constructor, which is a faithful
// stand-in for the real causes: a malformed import, a Places result with a null geometry,
// a hand-edited game file.
const degenerateStep = (id = "bad") => ({
  id, tool: "matching", enabled: true,
  inputs: {
    mode: "nearest",
    features: [
      { name: "A", lng: NaN, lat: 19.08 },
      { name: "B", lng: 72.88, lat: NaN },
    ],
  },
  answer: { featureIndex: 0, keep: true },
});

test("a step that cannot compute is reported to onFail with a reason", () => {
  const board = BOARD();
  const seen = [];
  computeActiveArea(board, [degenerateStep()], (id, reason) => seen.push({ id, reason }));

  assert.equal(seen.length, 1, "exactly one failure must be reported");
  assert.equal(seen[0].id, "bad");
  assert.ok(
    seen[0].reason === "compute" || seen[0].reason === "union",
    `reason must identify the failure kind, got ${JSON.stringify(seen[0].reason)}`,
  );
});

test("a failing step does not take the rest of the board down with it", () => {
  const board = BOARD();
  // One good radar, one broken question. The good one must still eliminate.
  const steps = [radarStep({ id: "good", radiusM: 9000, side: "in" }), degenerateStep()];
  const seen = [];
  const active = computeActiveArea(board, steps, (id, reason) => seen.push({ id, reason }));

  assert.ok(active, "the fold must survive one broken step");
  assert.equal(seen.length, 1, "only the broken step is reported");
  assert.equal(seen[0].id, "bad");

  // And the surviving area must be the good radar's, not the whole board — proving the
  // failure did not silently disable the rest of the fold.
  const areaOf = (g) => globalThis.turf.area(globalThis.turf.feature(g)) / 1e6;
  assert.ok(areaOf(active) < areaOf(board) * 0.9, "the healthy question must still be applied");
});

// The distinction the fix restores. A step that legitimately rules nothing out (an
// unanswered question) must NOT be reported as a failure — otherwise the banner cries wolf
// on every half-finished board and seekers learn to ignore it.
test("a step that legitimately eliminates nothing is not reported as a failure", () => {
  const board = BOARD();
  const unanswered = {
    id: "open", tool: "radar", enabled: true,
    inputs: { center: { lng: 72.8777, lat: 19.076 }, radius: 5000 },
    answer: {}, // no side — readSide returns null, elimination is null on purpose
  };
  const seen = [];
  const active = computeActiveArea(board, [unanswered], (id, reason) => seen.push({ id, reason }));

  assert.equal(seen.length, 0, "an unanswered question is not a failure");
  assert.equal(active, board, "and it rules nothing out");
});

// Disabled steps are not computed at all, so they can neither fail nor be reported.
test("a disabled broken step is not computed and not reported", () => {
  const board = BOARD();
  const off = { ...degenerateStep("offbad"), enabled: false };
  const seen = [];
  const active = computeActiveArea(board, [off], (id, reason) => seen.push({ id, reason }));

  assert.equal(seen.length, 0, "disabled steps are skipped entirely");
  assert.equal(active, board);
});

// Every failure must be reported on EVERY render, not just the first. `layers.js` resets
// `failedSteps` at the top of each render and repopulates it purely from `onFail`, so a
// second call that stayed quiet would drop the ⚠ badge while the question was still broken.
// The fold memo makes this a real risk — it is the exact regression its own comment warns of.
// The two inputs that LOOK like they should break the partition and must not. Both are real
// board shapes: Places routinely lists two venues at one coordinate, and "stations along one
// straight rail line" is exactly the Metro Lines / Name Length candidate set.
test("coincident candidates are rescued by dejitter rather than failing", () => {
  const board = BOARD();
  const coincident = {
    id: "same", tool: "matching", enabled: true,
    inputs: {
      mode: "nearest",
      features: [
        { name: "A", lng: 72.88, lat: 19.08 },
        { name: "B", lng: 72.88, lat: 19.08 },
        { name: "C", lng: 72.88, lat: 19.08 },
      ],
    },
    answer: { featureIndex: 0, keep: true },
  };
  const seen = [];
  const active = computeActiveArea(board, [coincident], (id, reason) => seen.push({ id, reason }));
  assert.equal(seen.length, 0, "duplicate coordinates must not be a failure — dejitter exists for this");
  assert.ok(active, "and the partition must still produce an area");
});

test("exactly collinear candidates still partition", () => {
  const board = BOARD();
  const collinear = {
    id: "line", tool: "matching", enabled: true,
    inputs: {
      mode: "nearest",
      features: Array.from({ length: 6 }, (_, i) => ({ name: `S${i}`, lng: 72.88, lat: 19.00 + i * 0.02 })),
    },
    answer: { featureIndex: 2, keep: true },
  };
  const seen = [];
  const active = computeActiveArea(board, [collinear], (id, reason) => seen.push({ id, reason }));
  assert.equal(seen.length, 0, "stations along one straight line are a normal board, not a failure");
  assert.ok(active);
});

test("failures are re-reported on a repeat render, not swallowed by the memo", () => {
  const board = BOARD();
  const steps = [radarStep({ id: "good", radiusM: 9000, side: "in" }), degenerateStep()];

  const first = [];
  computeActiveArea(board, steps, (id, reason) => first.push({ id, reason }));
  const second = [];
  computeActiveArea(board, steps, (id, reason) => second.push({ id, reason }));

  assert.deepEqual(second, first, "a repeated render must report the same failures");
  assert.equal(second.length, 1, "and must still report them at all");
});
