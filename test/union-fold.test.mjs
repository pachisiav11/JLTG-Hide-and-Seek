// C1-5: a failed union mid-fold discarded everything folded so far.
//
// Two places still carried the shape `lineCells` was already fixed for (the A7 note in
// tools.js). `safeUnion` swallows its exception and returns null, so:
//
//     union = union ? safeUnion(union, c) : c;
//
// one failure nulls the accumulator, and the NEXT iteration takes the falsy branch and
// restarts from that single geometry. Everything merged so far vanishes. The elimination built
// from the fragment then removes the wrong ground, and nothing on screen says so.
//
//   matchingNameLength (tools.js:310)  — "which station names are N letters" keeps or removes
//                                        the union of those cells. A reset fold keeps/removes
//                                        only the cells after the failure.
//   tentacles "none"   (tools.js:567)  — the hider is in NONE of the circles, so the union of
//                                        all of them is eliminated. A reset fold eliminates
//                                        only the last circle, leaving ground the hider has
//                                        already been ruled out of.
//
// Both now go through `unionAll`, which keeps the last good accumulator and drops only the
// member that would not merge. That under-eliminates rather than eliminating somewhere wrong,
// which is the safe direction: a seeker who eliminates too little wastes a question, a seeker
// who eliminates the wrong ground loses the hider.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { turf } from "./helpers/turf-env.mjs";
import { unionAll } from "../src/tools.js";

const sq = (x, y, s = 1) => turf.polygon([[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]]).geometry;
const km2 = (g) => (g ? turf.area(turf.feature(g)) / 1e6 : 0);

// Four disjoint unit squares, so the union's area is exactly the sum and any loss is visible.
const PARTS = [sq(0, 0), sq(2, 0), sq(4, 0), sq(6, 0)];

test("a clean fold covers every member", () => {
  const out = unionAll(PARTS);
  const sum = PARTS.reduce((n, p) => n + km2(p), 0);
  assert.ok(Math.abs(km2(out) - sum) / sum < 1e-6, `expected ${sum}, got ${km2(out)}`);
});

test("one failed merge drops ONLY that member — the rest survive", () => {
  // This is the finding. With the old fold, failing on member 2 discarded members 0 and 1 and
  // the result was members 2..3 only.
  let calls = 0;
  const flaky = (a, b) => {
    calls++;
    if (calls === 2) return null; // safeUnion swallowed a turf failure here
    return turf.union(turf.featureCollection([turf.feature(a), turf.feature(b)]))?.geometry ?? null;
  };
  const out = unionAll(PARTS, flaky);
  const all = PARTS.reduce((n, p) => n + km2(p), 0);
  const lost = km2(PARTS[2]);
  assert.ok(Math.abs(km2(out) - (all - lost)) / all < 1e-6,
    `expected the other three (${all - lost}), got ${km2(out)}`);
  // And specifically: the members BEFORE the failure must still be there.
  assert.ok(turf.booleanPointInPolygon(turf.point([0.5, 0.5]), turf.feature(out)),
    "member 0 was folded before the failure and must not have been discarded");
  assert.ok(turf.booleanPointInPolygon(turf.point([2.5, 0.5]), turf.feature(out)),
    "member 1 was folded before the failure and must not have been discarded");
});

test("the old fold really did lose them — the bug, reproduced", () => {
  // Reproduces the exact previous expression so the regression this guards is not theoretical.
  let calls = 0;
  const flaky = (a, b) => {
    calls++;
    if (calls === 2) return null;
    return turf.union(turf.featureCollection([turf.feature(a), turf.feature(b)]))?.geometry ?? null;
  };
  let union = null;
  for (const c of PARTS) union = union ? flaky(union, c) : c;
  // members 0 and 1 are gone; the fold restarted at member 2
  assert.ok(!turf.booleanPointInPolygon(turf.point([0.5, 0.5]), turf.feature(union)),
    "the old fold kept member 0 — then there was no bug to fix");
  assert.ok(km2(union) < km2(unionAll(PARTS, flaky)),
    "the old fold covered strictly less ground than the new one");
});

test("every merge failing still yields the first member, not null", () => {
  const out = unionAll(PARTS, () => null);
  assert.ok(out, "a total union failure must not erase the fold entirely");
  assert.ok(Math.abs(km2(out) - km2(PARTS[0])) / km2(PARTS[0]) < 1e-6);
});

test("nulls and an empty list are handled without a special case at the call sites", () => {
  assert.equal(unionAll([]), null);
  assert.equal(unionAll([null, null]), null);
  const out = unionAll([null, PARTS[0], null, PARTS[1]]);
  assert.ok(Math.abs(km2(out) - (km2(PARTS[0]) + km2(PARTS[1]))) / km2(PARTS[0]) < 1e-6);
});

test("neither call site still carries the resetting fold", () => {
  const src = readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
  // Code only — the pattern is quoted in unionAll's own comment explaining why it is wrong.
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\\)/.test(l)).join("\n");
  const hits = code.match(/union = union \? safeUnion\(union, [^)]*\) : /g) || [];
  assert.equal(hits.length, 0, `the resetting fold survives in ${hits.length} place(s)`);
});
