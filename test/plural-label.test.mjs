// The candidate sheets read "Tick the {label}s that count". Card labels are inconsistent by
// design — Tentacles cards are plural ("Museums"), Matching and Measuring cards are singular
// ("Museum") — so appending "s" to all of them produced "museumss" on half the deck.
//
// This walks the ACTUAL card labels rather than invented strings: the point is that the copy
// is right for every card the app ships, not that a pluraliser is correct in general.
import test from "node:test";
import assert from "node:assert/strict";
import { pluralLabel } from "../src/ui.js";
import { TENTACLES, MATCHING, MEASURING } from "../src/data/questions.js";

test("an already-plural Tentacles label is left alone", () => {
  for (const c of TENTACLES) assert.equal(pluralLabel(c.label), c.label, c.label);
});

test("no card label ever comes back with a doubled s", () => {
  for (const c of [...TENTACLES, ...MATCHING, ...MEASURING]) {
    assert.ok(!/ss$/i.test(pluralLabel(c.label)) || /ss$/i.test(c.label),
      `${c.label} -> ${pluralLabel(c.label)}`);
    assert.doesNotMatch(pluralLabel(c.label), /sss/i);
  }
});

test("singular card labels pluralise the way the copy needs", () => {
  assert.equal(pluralLabel("Museum"), "Museums");
  assert.equal(pluralLabel("Library"), "Libraries");
  assert.equal(pluralLabel("Golf Course"), "Golf Courses");
  assert.equal(pluralLabel("Commercial Airport"), "Commercial Airports");
  assert.equal(pluralLabel("Foreign Consulate"), "Foreign Consulates");
  // "Landmass" is singular despite ending in s — the ss is what tells them apart.
  assert.equal(pluralLabel("Landmass"), "Landmasses");
});

test("the exact string from the bug report", () => {
  assert.equal(`Tick the ${pluralLabel("Museums").toLowerCase()} that count`,
    "Tick the museums that count");
});

test("a user-named custom category is handled without inventing morphology", () => {
  assert.equal(pluralLabel("Chai stall"), "Chai stalls");
  assert.equal(pluralLabel("Chai stalls"), "Chai stalls"); // already plural, untouched
  assert.equal(pluralLabel(""), "");
  assert.equal(pluralLabel(null), "");
});
