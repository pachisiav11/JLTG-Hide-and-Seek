import test from "node:test";
import assert from "node:assert/strict";
import { buildCountryQuery, countryNameFromQuery, countryDivisionLevel, COUNTRY_DIVISION_LEVELS } from "../overpass-lines.js";

// Build an is_in response from [level, name] pairs (plus optional extra tags per area).
const res = (...areas) => ({
  elements: areas.map(([level, name, extra = {}]) => ({ tags: { admin_level: String(level), "name:en": name, ...extra } })),
});

test("the country query asks is_in for the whole hierarchy (SAR detection needs level 3–4)", () => {
  const q = buildCountryQuery(19.076, 72.8777);
  assert.match(q, /is_in\(19\.076,72\.8777\)/);
  assert.match(q, /\["boundary"="administrative"\]/);
  assert.doesNotMatch(q, /\["admin_level"="2"\]/, "must NOT filter to level 2 — HK's key is a level-3/4 area");
  assert.doesNotMatch(q, /around:/, "around: answers a different question and omits the country");
});

test("countryNameFromQuery reads the level-2 country name", () => {
  assert.equal(countryNameFromQuery(res([2, "Japan"], [4, "Tokyo"])), "Japan");
  assert.equal(countryNameFromQuery({ elements: [{ tags: { admin_level: "2", name: "日本" } }] }), "日本", "falls back to name without name:en");
  assert.equal(countryNameFromQuery({ elements: [] }), null);
  assert.equal(countryNameFromQuery(null), null);
});

test("a maritime-boundary level-2 area never wins the country", () => {
  // The real bug: `is_in` at Taipei returns BOTH "Taiwan maritime boundary" (border_type=
  // territorial) and "Taiwan", and elements[0] was the maritime one — so Taiwan resolved to a
  // sea polygon with no table entry, silently disabling both border cards nationwide.
  assert.equal(countryNameFromQuery(res(
    [2, "Taiwan maritime boundary", { border_type: "territorial" }],
    [2, "Taiwan"], [4, "Taipei"], [9, "Xicun Village"],
  )), "Taiwan");
  // Greece's Strofades territorial-waters area is the same shape, non-Taiwan.
  assert.equal(countryNameFromQuery(res(
    [2, "Territorial waters of Greece - Strofades"], [2, "Greece"], [4, "Attica"],
  )), "Greece");
});

test("Hong Kong and Macau are keyed by their own name, not China", () => {
  // Both SARs sit UNDER China's level-2 polygon (is_in returns level-2 "China") but run their
  // own division systems. Keying them as China would hand them China's [4, 6], which is
  // meaningless in HK — it has no level-4 province of its own.
  assert.equal(countryNameFromQuery(res([2, "China"], [3, "Hong Kong"], [4, "Hong Kong"], [5, "Hong Kong Island"], [6, "Central and Western District"])), "Hong Kong");
  assert.equal(countryNameFromQuery(res([2, "China"], [3, "Macau"], [6, "Santo António"])), "Macau");
  // The override must NOT misfire on the mainland: Beijing is China, not an SAR.
  assert.equal(countryNameFromQuery(res([2, "China"], [4, "Beijing"], [6, "Dongcheng District"])), "China");
});

test("Hong Kong resolves to region (5) then district (6) — the fix the game needed", () => {
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Hong Kong"], [5, 6]);
  assert.equal(countryDivisionLevel("Hong Kong", 1), 5);
  assert.equal(countryDivisionLevel("Hong Kong", 2), 6);
});

test("the level is a NATIONWIDE constant, not a per-board derivation", () => {
  // The point of the whole design: a Matching card asks whether two players are in the SAME
  // division, which is only well-posed if both compare the same kind of boundary. Japan must
  // answer the same level in Tokyo and in Sapporo.
  assert.equal(countryDivisionLevel("Japan", 1), 4);
  assert.equal(countryDivisionLevel("Japan", 2), 7);
});

test("Japan and Taiwan pick the level that is universal, not the city-only one", () => {
  // Japan: level 7 (municipality) covers Hokkaido too (Shintoku is level 7, a Tokyo ward's
  // tier); level 5 (subprefecture) is Hokkaido-only, so excluded.
  assert.equal(countryDivisionLevel("Japan", 2), 7);
  assert.notEqual(countryDivisionLevel("Japan", 2), 5);
  // Taiwan: level 7 (district) exists only in cities, level 8 (township) only in counties —
  // neither universal — but level 9 (village) is, at 18/18 land points.
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Taiwan"], [4, 9]);
});

test("city-states correctly DEMOTE their country's 2nd division to a fallback", () => {
  // The consistency rule's whole payload: a level that is absent anywhere a hider could stand
  // is not usable. Washington DC has no county, Berlin/Hamburg no level 6, Moscow no rayon,
  // Kuala Lumpur no district. Each leaves its country with a 1st division but no 2nd, so that
  // card hand-draws rather than drawing a boundary a hider in the city-state has no match for.
  for (const c of ["United States", "Germany", "Russia", "Australia", "United Kingdom", "Malaysia"]) {
    assert.equal(countryDivisionLevel(c, 1), 4, `${c} still has a 1st division`);
    assert.equal(countryDivisionLevel(c, 2), null, `${c} has no nationwide-consistent 2nd division`);
  }
});

test("table keys are what is_in ACTUALLY returns, not this game's shorthand", () => {
  // Verified live: London returns name:en "United Kingdom", never "UK". A mismatched key is a
  // silent miss — the card falls back for that whole country, forever. Caught during the redo:
  // the table was first written "UK"/"USA"/"UAE" and every one lost its border cards.
  assert.equal(countryDivisionLevel("UK", 1), null, "not a real is_in name — must not resolve");
  assert.equal(countryDivisionLevel("USA", 1), null, "not a real is_in name — must not resolve");
  assert.equal(countryDivisionLevel("United Kingdom", 1), 4);
  assert.equal(countryDivisionLevel("United States", 1), 4);
});

test("the Philippines has no consistent 1st division at all, and is omitted", () => {
  // Zamboanga City sits outside any province, so even ordinal 1 has no safe answer.
  assert.equal(countryDivisionLevel("Philippines", 1), null);
  assert.ok(!("Philippines" in COUNTRY_DIVISION_LEVELS), "omitted entirely, not an empty guess");
});

test("a country outside the measured set resolves to null, not a guess", () => {
  assert.equal(countryDivisionLevel("Atlantis", 1), null);
  assert.equal(countryDivisionLevel("", 1), null);
  assert.equal(countryDivisionLevel(undefined, 1), null);
});

test("the measured table matches the spike report for spot-check countries", () => {
  // A wrong level here is as bad as no level at all, so assert exact arrays.
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["India"], [4, 5]);
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["United States"], [4]);   // DC has no county
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Singapore"], [5, 6]);
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Switzerland"], [4, 8]);
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Ireland"], [5, 6]);
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Hong Kong"], [5, 6]);
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Taiwan"], [4, 9]);
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["China"], [4, 6]);        // Beijing/Shanghai skip level 5
});
