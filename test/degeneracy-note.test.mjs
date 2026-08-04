// v2 Phase 2, item I — warn when a partition has collapsed.
//
// A Voronoi over one seed is a valid partition that answers nothing: every point on the
// board is nearest to the only candidate. Over two seeds it is a single bisector — a
// Thermometer wearing a different card's name. Both are legitimate questions to ask; both
// are much weaker than the card's wording implies, and the geometry gives no hint. A seeker
// spends a question and gets a half-board elimination they read as a strong result.
//
// The Metro Lines card already carried a hand-written version of this warning and it was
// the most useful sentence in that flow. Every other card that partitions a candidate set
// had the same failure mode and said nothing. This is that sentence, generalised.
//
// The wording is tested rather than just the presence of a string because it is the whole
// product of the function: what a seeker needs is the CONSEQUENCE ("this can only tell you
// whether they're within 2 km"), not the diagnosis ("degenerate partition").
import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionDegeneracyNote } from "../src/tools.js";

test("no candidates: says the question will eliminate nothing", () => {
  const note = partitionDegeneracyNote(0, { kind: "museums" });
  assert.match(note, /No museums found/);
  assert.match(note, /eliminate nothing/);
});

test("one candidate WITH a reach collapses to a radius question, and says so", () => {
  const note = partitionDegeneracyNote(1, { kind: "lines", reach: "2 km" });
  assert.match(note, /Only one/);
  assert.match(note, /within 2 km of you/, "the consequence must name the reach it collapses to");
  assert.match(note, /can't distinguish between lines/);
});

test("one candidate WITHOUT a reach can eliminate nothing at all", () => {
  // Matching has no radius to fall back on, so a single candidate is not a weaker question,
  // it is a no-op. That is a different sentence and must not be conflated with the reach case.
  const note = partitionDegeneracyNote(1, { kind: "airports" });
  assert.match(note, /every point on the board is nearest to it/i);
  assert.match(note, /cannot eliminate anything/);
  assert.doesNotMatch(note, /within/, "with no reach there is nothing for it to collapse into");
});

test("two candidates are a thermometer, and the note says which", () => {
  const note = partitionDegeneracyNote(2, { kind: "zoos" });
  assert.match(note, /two zoos/);
  assert.match(note, /Thermometer/, "naming the equivalent card is the useful part");
});

test("three or more is a real partition — no warning", () => {
  for (const n of [3, 4, 12, 60]) {
    assert.equal(partitionDegeneracyNote(n, { kind: "museums" }), null, `${n} candidates must not warn`);
  }
});

test("the singular is used when the note names one candidate", () => {
  const note = partitionDegeneracyNote(2, { kind: "stations" });
  assert.match(note, /station question/, "'stations' must singularise for the trailing noun");
});

test("junk counts are treated as none rather than throwing", () => {
  // Reached whenever a search fails and hands back undefined — the sheet must still render.
  for (const bad of [undefined, null, NaN, -1]) {
    const note = partitionDegeneracyNote(bad, { kind: "parks" });
    assert.match(note, /No parks found/, `${String(bad)} must fall through to the empty case`);
  }
});

test("defaults are usable without options", () => {
  assert.match(partitionDegeneracyNote(1), /candidates/);
});
