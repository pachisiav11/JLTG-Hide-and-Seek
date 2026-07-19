// C3-4: `validateGame` took a zone's polygon ELEMENTS on trust.
//
// It checked `Array.isArray(z.polygon)` and stopped there, so a board file whose rings are
// `[{lat,lng}, ...]` instead of `[[lat,lng], ...]` passed validation, loaded, and then threw
// inside `ringToTurf` (geo.js:40) on the next zone edit. That throw escaped `addZone`'s
// store.update mutator, so the `pop()` that undoes a refused zone never ran and the rejected
// zone stayed on the board.
//
// `Zones._fold` now converts that throw to ok:false (046b82c), but converting a failure is a
// worse outcome than never loading the board: the player gets a zone list they cannot use and
// no explanation. This refuses it at the door instead, which is where an import belongs.
//
// Nothing in the app produces the bad shape. An import is whatever someone hands you — a shared
// game, a hand-edited export, a file from another tool.
import test from "node:test";
import assert from "node:assert/strict";
import { validateGame } from "../src/model.js";

const game = (zones) => ({
  id: "g1", schemaVersion: 1, zones, history: [],
});
const goodRing = [[18.9, 72.8], [18.9, 72.9], [19.0, 72.9], [19.0, 72.8], [18.9, 72.8]];

test("a well-formed board still validates", () => {
  assert.equal(validateGame(game([{ id: "z", name: "Z", polygon: goodRing }])), null);
});

test("the object-shaped ring that caused the bug is refused", () => {
  const bad = [{ lat: 19, lng: 72 }, { lat: 19.1, lng: 72.1 }, { lat: 19.1, lng: 72 }];
  const err = validateGame(game([{ id: "z", name: "Z", polygon: bad }]));
  assert.match(String(err), /vertex 0 is not a \[lat, lng\] pair/);
});

test("non-numeric and non-finite vertices are refused", () => {
  for (const pt of [["a", "b"], [NaN, 72], [19, Infinity], [null, 72], [undefined, 72]]) {
    const err = validateGame(game([{ id: "z", name: "Z", polygon: [pt] }]));
    assert.ok(err, `${JSON.stringify(pt)} should have been refused`);
    assert.match(String(err), /not a pair of numbers|not a \[lat, lng\] pair/);
  }
});

test("a one-element vertex is refused", () => {
  const err = validateGame(game([{ id: "z", name: "Z", polygon: [[19]] }]));
  assert.match(String(err), /not a \[lat, lng\] pair/);
});

test("coordinates off the globe are refused, and the message says which", () => {
  const lat = validateGame(game([{ id: "z", name: "Z", polygon: [[91, 72]] }]));
  assert.match(String(lat), /latitude 91/);
  const lng = validateGame(game([{ id: "z", name: "Z", polygon: [[19, 181]] }]));
  assert.match(String(lng), /longitude 181/);
});

test("the error names the zone and the vertex, so a broken file can be found", () => {
  const err = validateGame(game([
    { id: "a", name: "A", polygon: goodRing },
    { id: "b", name: "B", polygon: [[19, 72], [19.1, 72.1], { lat: 19, lng: 72 }] },
  ]));
  assert.match(String(err), /zone 1 vertex 2/);
});

test("short and empty rings are still ACCEPTED — _fold tolerates them", () => {
  // Refusing these would reject boards that work today: Zones._fold skips a degenerate ring and
  // folds the rest, and a test pins that toleration. Validation must not be stricter than the
  // engine it protects.
  assert.equal(validateGame(game([{ id: "z", name: "Z", polygon: [] }])), null);
  assert.equal(validateGame(game([{ id: "z", name: "Z", polygon: [[19, 72]] }])), null);
  assert.equal(validateGame(game([{ id: "z", name: "Z", polygon: [[19, 72], [19.1, 72.1]] }])), null);
});

test("an unreadable step ANSWER is still accepted, on purpose", () => {
  // The deliberate asymmetry. An unreadable answer degrades gracefully (readSide eliminates
  // nothing, describeStep says "unanswered"), so the board still loads and every other question
  // still works. Throwing away a mostly-fine game over one bad answer is the worse trade.
  const g = {
    id: "g1", zones: [{ id: "z", name: "Z", polygon: goodRing }],
    history: [{ id: "s1", tool: "thermometer", enabled: true, inputs: { a: {}, b: {} }, answer: { side: "banana" } }],
  };
  assert.equal(validateGame(g), null, "a bad answer must not cost the player the whole board");
});

test("a step with an unknown tool is still refused", () => {
  const g = {
    id: "g1", zones: [],
    history: [{ id: "s1", tool: "teleporter", enabled: true, inputs: {}, answer: {} }],
  };
  assert.match(String(validateGame(g)), /unknown tool "teleporter"/);
});
