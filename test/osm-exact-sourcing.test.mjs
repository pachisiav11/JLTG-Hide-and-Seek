// v2 — MAPPER_ANALYSIS §8.3 items 5 and 6: source from OSM the things Google cannot express.
//
// §8.3 lists six data layers where OSM beats Google outright. Four were already done (rail
// geometry, line membership, coastline, admin boundaries). These are the other two, and both
// share a failure mode that is easy to miss because it looks like it works:
//
//   Google has NO category for a mountain or for a restaurant chain. Its only option is a
//   NAME search. "mountain" matches "Mountain View Hotel"; "McDonald's" matches "McDonald's
//   Farm Supply". The card returns results, the partition builds, the map shades — and the
//   question the hider answered is not the question the seeker asked.
//
// OSM has an exact tag for each: natural=peak, and brand:wikidata (a stable entity id, so it
// is immune to McDonald's / McDonalds / マクドナルド and to franchise naming). So for these
// cards OSM is asked FIRST and Google is the fallback, inverting the usual order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const places = readFileSync(new URL("../src/places.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const questions = readFileSync(new URL("../src/data/questions.js", import.meta.url), "utf8");

test("the server maps peaks and both chains to exact OSM tags", () => {
  assert.match(server, /mountain:\s*\[\["natural",\s*"peak"\]\]/, "natural=peak is the exact tag");
  assert.match(server, /mcdonalds:\s*\[\["brand:wikidata",\s*"Q38076"\]\]/, "Q38076 is McDonald's");
  assert.match(server, /seven_eleven:\s*\[\["brand:wikidata",\s*"Q259340"\]\]/, "Q259340 is 7-Eleven");
});

test("brand lookups use brand:wikidata, never a name match", () => {
  // The entire point of item 5. A name= query reintroduces exactly the fragility OSM is
  // being used to escape.
  assert.doesNotMatch(server, /mcdonalds:\s*\[\["name"/, "a name match would defeat the purpose");
  assert.doesNotMatch(server, /seven_eleven:\s*\[\["name"/);
});

test("the client mirrors the server's category keys", () => {
  // A key the client cannot name is a card that silently never reaches Overpass.
  for (const key of ["mcdonalds", "seven_eleven"]) {
    assert.ok(places.includes(`"${key}"`), `${key} must be in the client's OVERPASS_TYPES`);
  }
});

test("peaks and chains are asked of OSM FIRST, not as a fallback", () => {
  assert.match(places, /OSM_EXACT_CATEGORIES\s*=\s*new Set\(\[[^\]]*"mountain"/s);
  assert.match(places, /OSM_EXACT_CATEGORIES\s*=\s*new Set\(\[[^\]]*"mcdonalds"/s);
  assert.match(places, /OSM_EXACT_CATEGORIES\s*=\s*new Set\(\[[^\]]*"seven_eleven"/s);
  // And the set is actually consulted on the Overpass-first branch.
  assert.match(places, /DENSE_CATEGORIES\.has\(cat\)\s*\|\|\s*OSM_EXACT_CATEGORIES\.has\(cat\)/);
});

test("OSM_EXACT is a separate concept from DENSE, not a rename of it", () => {
  // DENSE is about VOLUME (Google's 60-cap deciding the answer); OSM_EXACT is about
  // CORRECTNESS (a name search answering a different question). Collapsing them would lose
  // the reason either exists.
  assert.match(places, /const DENSE_CATEGORIES/);
  assert.match(places, /const OSM_EXACT_CATEGORIES/);
  assert.notEqual(
    places.indexOf("const DENSE_CATEGORIES"), places.indexOf("const OSM_EXACT_CATEGORIES"),
  );
});

test("the chain cards exist in the Measuring bank", () => {
  assert.match(questions, /id:\s*"mcdonalds",\s*label:\s*"McDonald's"/);
  assert.match(questions, /id:\s*"seven_eleven",\s*label:\s*"7-Eleven"/);
});

test("the chain keywords route to the right category, including spelling variants", async () => {
  // deriveOverpassCategory is module-private, so this pins the map it reads instead —
  // the variants are the failure mode (an apostrophe difference silently disabling OSM).
  for (const variant of ["mcdonald's", "mcdonalds", "7-eleven", "seven eleven"]) {
    assert.ok(places.toLowerCase().includes(`"${variant}"`), `"${variant}" must map to a category`);
  }
});
