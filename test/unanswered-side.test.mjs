// C1-7: an unreadable answer produced a confident WRONG elimination.
//
// Found during the cycle-1 game tests, by feeding a thermometer step the wrong answer key and
// noticing the board still lost a specific half. `side === "hotter" ? A : B` treats every
// unrecognised value — undefined, a renamed key, a future schema's wording — as a vote for B.
//
// Measured live on a 628.6 km2 Mumbai board:
//
//     answer {side:"hotter"}   eliminates 259.2 km2
//     answer {side:"colder"}   eliminates 369.5 km2   (259.2 + 369.5 = 628.7, complementary)
//     answer {}                eliminates 369.5 km2   <- the full colder half, from no answer
//     answer {side:"banana"}   eliminates 369.5 km2   <- same
//
// `describeStep` then labelled it "colder (→A)", so the questions panel AGREED with the wrong
// elimination instead of exposing it — the seeker has no way to notice.
//
// Reachable the same way C1-3 was: `validateGame` checks that a step names a known tool
// (model.js:106), never that its answer is readable, so an imported board carries whatever it
// carries. Three tools shared the shape: radar, thermometer and measuring's buffer path.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import { computeElimination, describeStep } from "../src/tools.js";

const AREA = squareArea([72.8777, 19.076], 0.2);
const km2 = (g) => (g ? turf.area(turf.feature(g)) / 1e6 : 0);

const radar = (answer) => ({ id: "r1", tool: "radar", enabled: true, inputs: { center: { lat: 19.076, lng: 72.8777 }, radius: 4000 }, answer });
const thermo = (answer) => ({ id: "t1", tool: "thermometer", enabled: true, inputs: { a: { lat: 19.00, lng: 72.82 }, b: { lat: 19.12, lng: 72.94 } }, answer });
const measure = (answer) => ({
  id: "m1", tool: "measuring", enabled: true,
  inputs: { refType: "line", distance: 2000, refGeometry: { type: "LineString", coordinates: [[72.80, 19.00], [72.95, 19.15]] } },
  answer,
});

const BAD = [{}, { side: undefined }, { side: null }, { side: "banana" }, { side: "IN" }, {}];

test("a radar with an unreadable answer eliminates nothing", () => {
  for (const answer of BAD) {
    const { eliminated } = computeElimination(radar(answer), AREA);
    assert.equal(eliminated, null, `radar answered ${JSON.stringify(answer)} must not eliminate`);
  }
});

test("a thermometer with an unreadable answer eliminates nothing", () => {
  for (const answer of BAD) {
    const { eliminated } = computeElimination(thermo(answer), AREA);
    assert.equal(eliminated, null, `thermometer answered ${JSON.stringify(answer)} must not eliminate`);
  }
});

test("a measuring step with an unreadable answer eliminates nothing", () => {
  for (const answer of BAD) {
    const { eliminated } = computeElimination(measure(answer), AREA);
    assert.equal(eliminated, null, `measuring answered ${JSON.stringify(answer)} must not eliminate`);
  }
});

test("real answers still eliminate, and still partition the board exactly", () => {
  // The guard must not have cost the tools their actual behaviour.
  const board = km2(AREA);
  for (const [tool, mk, a, b] of [
    ["radar", radar, "in", "out"],
    ["thermometer", thermo, "hotter", "colder"],
    ["measuring", measure, "in", "out"],
  ]) {
    const x = km2(computeElimination(mk({ side: a }), AREA).eliminated);
    const y = km2(computeElimination(mk({ side: b }), AREA).eliminated);
    assert.ok(x > 0, `${tool} "${a}" must still eliminate something`);
    assert.ok(y > 0, `${tool} "${b}" must still eliminate something`);
    assert.ok(Math.abs((x + y) - board) / board < 0.01,
      `${tool}: "${a}" + "${b}" should partition the board (${x.toFixed(1)} + ${y.toFixed(1)} vs ${board.toFixed(1)})`);
  }
});

test("an unanswered step is LABELLED unanswered, not as the else-branch", () => {
  // The half that made it invisible: the panel used to read "outside (No)" / "colder (→A)".
  assert.match(describeStep(radar({})), /unanswered/);
  assert.match(describeStep(thermo({})), /unanswered/);
  assert.match(describeStep(measure({})), /unanswered/);
  assert.match(describeStep(radar({ side: "banana" })), /unanswered/);
});

test("real answers are still labelled as before", () => {
  assert.match(describeStep(radar({ side: "in" })), /inside \(Yes\)/);
  assert.match(describeStep(radar({ side: "out" })), /outside \(No\)/);
  assert.match(describeStep(thermo({ side: "hotter" })), /hotter/);
  assert.match(describeStep(thermo({ side: "colder" })), /colder/);
  assert.match(describeStep(measure({ side: "in" })), /within/);
  assert.match(describeStep(measure({ side: "out" })), /beyond/);
});

test("measuring's REGION mode is untouched — it answers with `inside`, not `side`", () => {
  // It must not be refused for lacking a field it never uses.
  const region = (answer) => ({
    id: "m2", tool: "measuring", enabled: true,
    inputs: { refType: "region", ring: [[19.00, 72.82], [19.00, 72.94], [19.12, 72.94], [19.12, 72.82], [19.00, 72.82]] },
    answer,
  });
  assert.ok(computeElimination(region({ inside: true }), AREA).eliminated, "inside must still eliminate");
  assert.ok(computeElimination(region({ inside: false }), AREA).eliminated, "outside must still eliminate");
});

test("the guard is shared, not copy-pasted three times", () => {
  const src = readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
  assert.match(src, /function readSide\(step, allowed\)/, "one helper");
  const uses = (src.match(/readSide\(step, \[/g) || []).length;
  assert.equal(uses, 3, `expected radar, thermometer and measuring to use it; found ${uses}`);
});
