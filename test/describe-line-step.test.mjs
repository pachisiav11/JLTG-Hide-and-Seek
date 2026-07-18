// B1: a line-mode Tentacles step stores `inputs.lines` (labelled), a point-mode step stores
// `inputs.features` (named). describeStep read only `features`, so EVERY Metro Lines question
// rendered as `closest "?"` — indistinguishable from every other one in the Questions panel,
// which is the surface a seeker uses to decide which question to disable when the board looks
// wrong. It also seeded the rename field, carrying the "?" into the question's name.
//
// B3/B9: `_featureListHTML` pre-checked index 0, so the "require an explicit pick" guards were
// only reachable once the filter box had cleared the default. That is a DOM concern, but the
// consequence it produces is here: describeStep reporting a name the seeker never chose.
// `repairRadioSelection` is the seam the guard depends on, so pin the no-default contract.
import test from "node:test";
import assert from "node:assert/strict";
import { turf } from "./helpers/turf-env.mjs";
import { describeStep } from "../src/tools.js";
import { repairRadioSelection } from "../src/ui.js";

void turf; // describeStep is pure, but the import keeps the env consistent with the suite.

// Exactly the shape layers.js commits for a line-mode tentacles answer.
const lineStep = (featureIndex) => ({
  tool: "tentacles",
  inputs: {
    category: "subway_station", categoryLabel: "Metro Lines", radius: 25000,
    lines: [
      { id: "ln_0_subway:U2", label: "U2", paths: [[[13.40, 52.50], [13.41, 52.51]]] },
      { id: "ln_1_subway:S7", label: "S7", paths: [[[13.42, 52.52], [13.43, 52.53]]] },
    ],
    center: { lat: 52.50, lng: 13.40 },
  },
  answer: { featureIndex },
});

test("a line-mode tentacles step names the line the seeker picked", () => {
  assert.equal(describeStep(lineStep(0)), 'Tentacles · Metro Lines · closest “U2” (25 km)');
  assert.equal(describeStep(lineStep(1)), 'Tentacles · Metro Lines · closest “S7” (25 km)');
});

test("two line answers on the same card are distinguishable in the panel", () => {
  // The regression itself: before the fix both of these were the same string.
  assert.notEqual(describeStep(lineStep(0)), describeStep(lineStep(1)));
});

test("the point-mode step still reads its name from inputs.features", () => {
  const pointStep = {
    tool: "tentacles",
    inputs: { category: "museum", categoryLabel: "Museum", radius: 1600, features: [{ name: "Pergamon" }] },
    answer: { featureIndex: 0 },
  };
  assert.equal(describeStep(pointStep), 'Tentacles · Museum · closest “Pergamon” (1.6 km)');
});

test("a miss still reads as a miss, whichever shape the step carries", () => {
  const miss = { ...lineStep(0), answer: { none: true } };
  assert.equal(describeStep(miss), "Tentacles · Metro Lines · none within 25 km");
});

test("an unfiltered candidate list starts with nothing checked, so Add must be an explicit pick", () => {
  // No filter typed: every index visible, nothing checked. The list must stay unselected —
  // if this returns an index, the Add guard downstream is decorative again.
  assert.equal(repairRadioSelection({ visibleIdx: [0, 1, 2, 3], checkedIdx: null }), null);
});
