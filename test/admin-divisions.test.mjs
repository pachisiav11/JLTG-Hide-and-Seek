import test from "node:test";
import assert from "node:assert/strict";
import { buildCountryQuery, countryNameFromQuery, countryDivisionLevel, COUNTRY_DIVISION_LEVELS } from "../overpass-lines.js";

test("the country query asks is_in for level 2 only", () => {
  // Only the country name is needed to key COUNTRY_DIVISION_LEVELS — no need to fetch the
  // whole hierarchy the way the (rejected) per-board derivation did.
  const q = buildCountryQuery(19.076, 72.8777);
  assert.match(q, /is_in\(19\.076,72\.8777\)/);
  assert.match(q, /\["admin_level"="2"\]/);
  assert.doesNotMatch(q, /around:/, "around: answers a different question and omits the country");
});

test("countryNameFromQuery reads the level-2 area's name", () => {
  const res = (tags) => ({ elements: [{ tags }] });
  assert.equal(countryNameFromQuery(res({ admin_level: "2", "name:en": "Japan", name: "日本" })), "Japan");
  assert.equal(countryNameFromQuery(res({ admin_level: "2", name: "日本" })), "日本", "falls back to name without name:en");
  assert.equal(countryNameFromQuery({ elements: [] }), null);
  assert.equal(countryNameFromQuery(null), null);
});

test("the level is a NATIONWIDE constant, not a per-board derivation", () => {
  // This is the whole point of the redo. A Matching card asks whether two players are in the
  // SAME division, which only makes sense if both are comparing the same kind of boundary —
  // a seeker on Tokyo wards and a hider on a Hokkaido subprefecture are not one question, even
  // though each board's own hierarchy is internally correct. So the level must not vary by
  // which city inside Japan is asked.
  assert.equal(countryDivisionLevel("Japan", 1), 4);
  assert.equal(countryDivisionLevel("Japan", 2), 7);
});

test("Japan's 2nd division is the level that covers Hokkaido too, not the Sapporo-only one", () => {
  // Measured 2026-07-19 by a country-wide grid (scripts/spike-country-levels.js): level 7
  // (municipality) has 100% territorial coverage, INCLUDING Hokkaido — a Hokkaido town
  // (Shintoku) is level 7, the same tier as a Tokyo ward. Level 5 (subprefecture) only
  // covers Hokkaido (29% of the grid), so it is excluded even though it's the level a
  // Sapporo-centred query itself returns — that measurement answers a different question
  // (what's the ordinal AT Sapporo) than this one (what's usable EVERYWHERE in Japan).
  assert.equal(countryDivisionLevel("Japan", 2), 7);
  assert.notEqual(countryDivisionLevel("Japan", 2), 5);
});

test("table keys are what is_in ACTUALLY returns, not this game's shorthand", () => {
  // Verified live: London and Edinburgh both return name:en "United Kingdom", never "UK". A
  // key that doesn't match is a silent miss — countryDivisionLevel returns null and the
  // card quietly falls back to hand-drawing for that entire country, forever. This caught a
  // real bug during the redo: the table was first written with "UK"/"USA"/"UAE" and every
  // one of those countries silently lost its border cards until this was checked live.
  assert.equal(countryDivisionLevel("UK", 1), null, "not a real is_in name — must not resolve");
  assert.equal(countryDivisionLevel("USA", 1), null, "not a real is_in name — must not resolve");
  assert.equal(countryDivisionLevel("United Kingdom", 1), 4);
  assert.equal(countryDivisionLevel("United States", 1), 4);
});

test("a country can define fewer than 2 divisions, or none at all", () => {
  // The UK genuinely has no nationwide-consistent 2nd division (England/Scotland/Wales/NI
  // diverge) — this is a measured fact, not a gap in coverage of the spike itself.
  assert.equal(countryDivisionLevel("United Kingdom", 1), 4);
  assert.equal(countryDivisionLevel("United Kingdom", 2), null);

  // The Philippines has no consistent 1st division AT ALL: some cities (Zamboanga) sit
  // outside any province, so even ordinal 1 has no safe answer.
  assert.equal(countryDivisionLevel("Philippines", 1), null);
  assert.ok(!("Philippines" in COUNTRY_DIVISION_LEVELS), "omitted entirely, not an empty guess");
});

test("a country outside the measured 44 resolves to null, not a guess", () => {
  // Extending coverage means re-running the spike, not adding an entry from intuition — the
  // same "measure, don't guess" rule as everything else Overpass-sourced in this app.
  assert.equal(countryDivisionLevel("Atlantis", 1), null);
  assert.equal(countryDivisionLevel("", 1), null);
  assert.equal(countryDivisionLevel(undefined, 1), null);
});

test("the measured table matches the spike's coverage report for the cards' spot-check countries", () => {
  // A cross-section of the countries named in the redo request, verifying the exact levels
  // rather than just "truthy" — a wrong level here is as bad as no level at all.
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["India"], [4, 5]);
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["United States"], [4, 6]);
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Canada"], [4]);
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Singapore"], [5, 6]);
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Switzerland"], [4, 8]);
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Ireland"], [5, 6]);
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["New Zealand"], [4]);
});
