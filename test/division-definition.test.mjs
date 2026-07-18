// R3: the app shipped two contradicting answers to "what is a 1st/2nd admin division".
//
//   COUNTRY_DIVISION_LEVELS (overpass-lines.js) — measured, nationwide-constant OSM
//     admin_level per country. This is what the Measuring border cards actually draw.
//   DDS_ADMIN_LEVELS (places.js) — Google's FeatureLayers, which used to be LABELLED
//     "1st Admin division" / "2nd Admin division" / "≈3rd" in the tracing helper.
//
// Google's numbering is not the game's ordinals, and this test names the countries where
// believing otherwise puts a real boundary in the wrong place. The fix is that nothing claims
// an equivalence any more: the DDS labels are Google's own terms and the helper states both.
import test from "node:test";
import assert from "node:assert/strict";
import { COUNTRY_DIVISION_LEVELS } from "../overpass-lines.js";

test("the measured table is the game's definition, and it is not Google's numbering", () => {
  // Japan: the game's 2nd division is the municipality (7). Google's level-2 is the gun/county.
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Japan"], [4, 7]);
  // Ireland and Singapore do not even start at 4 — Google's level-1 is a different tier.
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Ireland"], [5, 6]);
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Singapore"], [5, 6]);
});

test("a country can have NO second division, so a 2nd-division card is not always well-posed", () => {
  // Berlin/Hamburg/Bremen are city-states: 4 -> 9 with no level 6, so no nationwide 2nd.
  assert.equal(COUNTRY_DIVISION_LEVELS["Germany"].length, 1);
  for (const c of ["Australia", "Canada", "Egypt", "Malaysia", "Russia"]) {
    assert.equal(COUNTRY_DIVISION_LEVELS[c].length, 1, c);
  }
});

test("an unmeasured country is absent rather than guessed", () => {
  // The Philippines has no level with full coverage even for the 1st division (Zamboanga City
  // sits outside any province), so it is deliberately omitted — measure, don't guess.
  assert.equal(COUNTRY_DIVISION_LEVELS["Philippines"], undefined);
  assert.equal(COUNTRY_DIVISION_LEVELS["UK"], undefined, "keys must match OSM's name:en, not shorthand");
  assert.equal(COUNTRY_DIVISION_LEVELS["USA"], undefined);
});

test("Hong Kong is keyed on its own, not inherited from China", () => {
  assert.deepEqual(COUNTRY_DIVISION_LEVELS["Hong Kong"], [5, 6]);
  assert.notDeepEqual(COUNTRY_DIVISION_LEVELS["Hong Kong"], COUNTRY_DIVISION_LEVELS["China"]);
});

test("every entry is a 1- or 2-element list of plausible OSM admin levels", () => {
  for (const [country, levels] of Object.entries(COUNTRY_DIVISION_LEVELS)) {
    assert.ok(Array.isArray(levels) && levels.length >= 1 && levels.length <= 2, country);
    for (const l of levels) {
      assert.ok(Number.isInteger(l) && l >= 3 && l <= 10, `${country}: admin_level ${l}`);
    }
    if (levels.length === 2) {
      assert.ok(levels[1] > levels[0], `${country}: the 2nd division must nest inside the 1st`);
    }
  }
});

test("no DDS label claims a game ordinal any more", async () => {
  // The labels live in places.js, which needs `google` at import time — read the source instead
  // of importing it. What matters is that the strings the tracing helper renders do not say
  // "1st Admin division"; that phrase is what made a player trace the wrong boundary.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/places.js", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const DDS_ADMIN_LEVELS"), src.indexOf("];", src.indexOf("const DDS_ADMIN_LEVELS")));
  for (const claim of ["1st Admin", "2nd Admin", "3rd Admin", "≈3rd"]) {
    assert.ok(!block.includes(claim), `DDS_ADMIN_LEVELS still claims "${claim}"`);
  }
  assert.ok(block.includes("Google:"), "DDS labels should name Google as the source");
});
