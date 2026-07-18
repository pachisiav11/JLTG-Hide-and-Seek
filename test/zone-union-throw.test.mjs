// C1-3: a THROWN zone union left the rejected zone on the board.
//
// Found while verifying P6 on a live Mumbai board, and narrower than it first looked. Measured,
// genuinely degenerate rings do NOT throw — `unionRings` skips them and the fold succeeds:
//
//     [[19,72],[19,72],[19,72],[19,72]]   identical points   -> ok: true
//     [[19,72],[19.1,72.1]]               two points         -> ok: true
//     [[19,72],[19,72.1],[19,72.2],[19,72]] collinear        -> ok: true
//     []  /  null                                            -> ok: true
//
// What throws is a ring of the wrong SHAPE — `[{lat,lng}, ...]` instead of `[[lat,lng], ...]`
// — because `ringToTurf` destructures each vertex (geo.js:40).
//
// That is reachable, and not only by a debug call. `validateGame` checks
// `Array.isArray(z.polygon)` but never the element shape (model.js:99), so an imported board
// file — a shared game, a hand-edited export, anything third-party — whose zones use the object
// shape passes validation, loads, and then throws on the next zone edit.
//
// When it threw, the exception propagated out of the `store.update` mutator in `addZone`, so
// the `g.zones.pop()` on the line after it never ran:
//
//     store.update((g) => {
//       g.zones.push(zone);
//       const { ok, area } = Zones._fold(g.zones);   // <- threw here
//       ...
//       g.zones.pop();                               // <- never reached
//     });
//
// Reproduced live: the board went from 1 zone to 2, the second being the one just refused, with
// `gameArea` never rebuilt to include it — the exact opposite of the guard's stated purpose,
// "refuse the ZONE rather than lose the BOARD".
//
// `zone-union-failure.test.mjs` covers the null-return case; this covers the throw.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { turf } from "./helpers/turf-env.mjs";
import { Zones } from "../src/zones.js";

const sq = (w, s, e, n) => [[s, w], [s, e], [n, e], [n, w], [s, w]]; // zones store [lat,lng]
const GOOD = sq(72.79, 18.89, 72.92, 19.02);
const OTHER = sq(72.85, 18.95, 72.98, 19.08);
// The shape an imported board can legally carry through validateGame, and that throws.
const WRONG_SHAPE = [{ lat: 19, lng: 72 }, { lat: 19.1, lng: 72.1 }, { lat: 19.1, lng: 72 }];
const km2 = (g) => (g ? turf.area(turf.feature(g)) / 1e6 : 0);

test("a wrongly-shaped ring is refused, not thrown", () => {
  // The whole finding: this must return, not throw, or the caller's undo never runs.
  let res;
  assert.doesNotThrow(() => {
    res = Zones._fold([{ polygon: GOOD }, { polygon: WRONG_SHAPE }]);
  }, "a throwing union must be converted, not propagated");
  assert.equal(res.ok, false, "a union that cannot be computed is a failed union");
  assert.equal(res.area, null);
});

test("a failed fold stays distinguishable from an empty board", () => {
  // The distinction _fold exists to protect: a null area must mean "no zones", and must not be
  // reachable by failure, or the map blanks with nothing saying why.
  const empty = Zones._fold([]);
  assert.equal(empty.ok, true, "no zones is a truthful null area");
  assert.equal(empty.area, null);

  const failed = Zones._fold([{ polygon: GOOD }, { polygon: WRONG_SHAPE }]);
  assert.equal(failed.ok, false, "a failure must not look like an empty board");
});

test("a wrongly-shaped zone alone does not silently become the board", () => {
  const res = Zones._fold([{ polygon: WRONG_SHAPE }]);
  assert.equal(res.ok, false);
  assert.equal(res.area, null);
});

test("good zones still fold normally", () => {
  const res = Zones._fold([{ polygon: GOOD }, { polygon: OTHER }]);
  assert.equal(res.ok, true);
  assert.ok(km2(res.area) > 100, `expected a Mumbai-sized board, got ${km2(res.area).toFixed(1)} km2`);
});

test("genuinely degenerate rings are still tolerated, not newly refused", () => {
  // These were always fine and must stay fine — the fix must not turn "skipped" into "refused",
  // which would start rejecting boards that work today.
  for (const [name, ring] of [
    ["identical points", [[19, 72], [19, 72], [19, 72], [19, 72]]],
    ["two points", [[19, 72], [19.1, 72.1]]],
    ["collinear", [[19, 72], [19, 72.1], [19, 72.2], [19, 72]]],
    ["empty", []],
  ]) {
    const res = Zones._fold([{ polygon: GOOD }, { polygon: ring }]);
    assert.equal(res.ok, true, `${name} used to fold cleanly and must continue to`);
    assert.ok(km2(res.area) > 100, `${name} must not shrink the board`);
  }
});

test("the conversion logs the cause rather than discarding it", () => {
  const src = readFileSync(new URL("../src/zones.js", import.meta.url), "utf8");
  assert.match(src, /catch \(e\) \{[\s\S]{0,200}console\.warn/, "the cause must stay visible");
  assert.match(src, /return \{ ok: false, area: null \};/, "and route to the existing refusal path");
});
