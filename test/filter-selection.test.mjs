// A8 — filtering a candidate list must never leave a hidden item checked.
//
// _featureListHTML marks i === 0 checked; the filter only set `display: none` and never
// touched `checked`. Type "Waterloo", see only Waterloo, assume filtering selected it, hit
// Add -> featureIndex 0 is recorded: a different, hidden station. The wrong question is
// committed silently, and describeStep then reports the wrong name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repairRadioSelection } from "../src/ui.js";

test("the Waterloo case: filtering to one match selects THAT match, not the hidden default", () => {
  // 12 stations, index 0 checked by default. Filtering to "Waterloo" leaves only index 7.
  const got = repairRadioSelection({ visibleIdx: [7], checkedIdx: 0 });
  // The precise regression: this returned 0 — a station the seeker could not see.
  assert.equal(got, 7);
  assert.notEqual(got, 0, "must not keep the filtered-away default");
});

test("a checked item that is still visible is kept", () => {
  assert.equal(repairRadioSelection({ visibleIdx: [0, 3, 7], checkedIdx: 3 }), 3);
});

test("a checked item that is hidden is cleared when the match is ambiguous", () => {
  // Several visible matches: there is no unambiguous choice, so require an explicit pick
  // rather than guessing.
  assert.equal(repairRadioSelection({ visibleIdx: [4, 5, 9], checkedIdx: 0 }), null);
});

test("no match at all clears the selection", () => {
  assert.equal(repairRadioSelection({ visibleIdx: [], checkedIdx: 0 }), null);
});

test("clearing the filter leaves nothing auto-selected rather than resurrecting index 0", () => {
  // All items visible again, nothing checked (it was cleared while hidden). Re-checking
  // index 0 here would quietly recreate the original bug.
  assert.equal(repairRadioSelection({ visibleIdx: [0, 1, 2, 3], checkedIdx: null }), null);
});

test("an unfiltered list with one item selects it", () => {
  assert.equal(repairRadioSelection({ visibleIdx: [0], checkedIdx: null }), 0);
});

test("a deliberate out-of-list choice (Tentacles' 'None — a miss') is never overridden", () => {
  // Filtering to a single visible candidate must not silently convert a recorded miss
  // into "closest to this one".
  assert.equal(repairRadioSelection({ visibleIdx: [2], checkedIdx: null, externalChecked: true }), null);
  assert.equal(repairRadioSelection({ visibleIdx: [2], checkedIdx: 0, externalChecked: true }), null);
});

test("index 0 is not special — the bug was that it was", () => {
  // Filtering to only index 0 legitimately selects it.
  assert.equal(repairRadioSelection({ visibleIdx: [0], checkedIdx: 0 }), 0);
  // But it is never resurrected once hidden.
  assert.equal(repairRadioSelection({ visibleIdx: [1, 2], checkedIdx: 0 }), null);
});
