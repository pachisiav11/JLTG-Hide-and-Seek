import test from "node:test";
import assert from "node:assert/strict";
import { buildDivisionsQuery, deriveDivisionLevels, DEFAULT_BORDER_LEVEL } from "../overpass-lines.js";

// Shorthand for an Overpass `is_in` response.
const el = (admin_level, name) => ({ tags: { boundary: "administrative", admin_level: String(admin_level), name } });
const res = (...els) => ({ elements: els });

test("the divisions query asks is_in, not around", () => {
  // `around:` returns areas NEAR the point, which is a different question: it omits the
  // enclosing country and includes divisions the board is not in. The distinction is invisible
  // in the response shape — both return areas — so it has to be asserted on the query string.
  const q = buildDivisionsQuery(19.076, 72.8777);
  assert.match(q, /is_in\(19\.076,72\.8777\)/);
  assert.doesNotMatch(q, /around:/);
  assert.match(q, /\["boundary"="administrative"\]/, "non-administrative areas are not divisions");
  assert.match(q, /out tags;/, "only tags are needed — geometry would be megabytes");
});

test("level 2 and level 3 are dropped, and dropping 3 is load-bearing", () => {
  // Level 3 is a macro-region, not an administrative division. The Netherlands is the case
  // that proves it cannot simply be ranked: its level 3 is "Netherlands" — the country's own
  // name repeated — so keeping it would make the 1st division a duplicate of the country.
  const nl = deriveDivisionLevels(res(
    el(2, "Netherlands"), el(3, "Netherlands"), el(4, "North Holland"), el(8, "Amsterdam"),
  ));
  assert.deepEqual(nl.map((d) => d.level), [4, 8]);
  assert.equal(nl[0].name, "North Holland");

  // France's level 3 is "Metropolitan France", Brazil's is "North Region" — same shape.
  const fr = deriveDivisionLevels(res(el(2, "France"), el(3, "Metropolitan France"), el(4, "Ile-de-France")));
  assert.deepEqual(fr.map((d) => d.level), [4]);
});

test("ordinals are positions in the hierarchy, not admin_levels", () => {
  // This is the whole point. Measured 2026-07-18: the SAME ordinal sits on different levels
  // in different countries, so a consumer must ask for "the 1st division" and be told which
  // level that is here — never the reverse.
  const tokyo = deriveDivisionLevels(res(el(2, "Japan"), el(4, "Tokyo"), el(7, "Suginami"), el(9, "Izumi")));
  assert.deepEqual(tokyo, [
    { ordinal: 1, level: 4, name: "Tokyo" },
    { ordinal: 2, level: 7, name: "Suginami" },
    { ordinal: 3, level: 9, name: "Izumi" },
  ]);

  // Sapporo, same country, different hierarchy: Hokkaido has a subprefecture tier (level 5)
  // that the other 46 prefectures lack. A per-country table would put Japan's 2nd division at
  // 7 and be wrong here — the variation is real administrative geography, not bad tagging.
  const sapporo = deriveDivisionLevels(res(el(2, "Japan"), el(4, "Hokkaido"), el(5, "Ishikari"), el(7, "Sapporo")));
  assert.equal(sapporo.find((d) => d.ordinal === 2).level, 5);
});

test("countries with no level 4 derive a 1st division anyway", () => {
  // The bug this replaced. Level 4 is absent in 22 of 271 probes; asking for it there is not
  // a near-miss but a wrong answer. Singapore is the sharpest case: a level-4 query on a
  // Singapore board returns ONE way named "Johor" — Malaysia's state border — which the card
  // would then buffer and measure against as if it were Singapore's 1st division.
  const sg = deriveDivisionLevels(res(el(2, "Singapore"), el(5, "Central Region"), el(6, "Bukit Timah")));
  assert.equal(sg[0].level, 5);
  assert.equal(sg[0].name, "Central Region");
  assert.equal(sg[0].ordinal, 1, "the 1st division is whatever is outermost, not whatever is level 4");

  // Ireland's is 5 (Provinces), Portugal's is 6 (Districts) — measured, both real divisions.
  assert.equal(deriveDivisionLevels(res(el(2, "Ireland"), el(5, "Leinster"), el(6, "County Dublin")))[0].level, 5);
  assert.equal(deriveDivisionLevels(res(el(2, "Portugal"), el(6, "Lisboa"), el(7, "Lisbon")))[0].level, 6);
});

test("duplicate levels collapse instead of shifting every ordinal below them", () => {
  // Several relations can share one level. Ranking them separately would push the real 2nd
  // division into 3rd place and silently ask about the wrong boundary.
  const d = deriveDivisionLevels(res(el(4, "Bavaria"), el(5, "Upper Bavaria"), el(5, "Munich Region"), el(6, "Munich")));
  assert.deepEqual(d.map((x) => x.level), [4, 5, 6]);
  assert.equal(d.find((x) => x.level === 5).name, "Upper Bavaria", "first name at a level wins");
});

test("a malformed or empty response derives nothing rather than guessing", () => {
  // An empty hierarchy must reach the caller as "no divisions here", so the card can fall back
  // to hand-drawing having SAID so. Substituting a default would draw a plausible wrong border.
  for (const bad of [null, undefined, {}, { elements: [] }, { elements: [{}] }, { elements: [{ tags: {} }] }]) {
    assert.deepEqual(deriveDivisionLevels(bad), []);
  }
  // Ocean/unparseable levels are dropped, not coerced to 0 and ranked first.
  assert.deepEqual(deriveDivisionLevels(res({ tags: { admin_level: "not-a-number" } })), []);
});

test("an unnamed division still ranks, but reports no name", () => {
  // The card shows the name so players can check the question is well-posed. A missing name is
  // null rather than a fabricated label — the ordinal is still correct and usable.
  const d = deriveDivisionLevels(res({ tags: { admin_level: "6" } }));
  assert.deepEqual(d, [{ ordinal: 1, level: 6, name: null }]);
});

test("the default border level is only a fallback for callers naming nothing", () => {
  // It stays 4 because that is the most common 1st division, but no in-app card relies on it:
  // measure-line.test.mjs asserts both border cards name a divisionOrdinal instead.
  assert.equal(DEFAULT_BORDER_LEVEL, 4);
});
