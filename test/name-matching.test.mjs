// B7 — resolve a typed station name against the LOCAL list before spending a round trip.
//
// After B1–B3 the complete candidate set for the play area is in memory (measured: 337
// stations in a Mumbai bbox), so this is a pure client-side filter. Going straight to
// Google both wasted a call and ADDED A DUPLICATE of a station already present — seeding
// the Voronoi twice at one spot.
//
// A8 had to land first: as it stood, typing a preference was actively dangerous.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName, matchNames } from "../src/places.js";

const LONDON = [
  "Waterloo Station", "Waterloo East Station", "London Bridge Station",
  "Euston Station", "King's Cross St. Pancras", "Victoria Station",
  "Paddington Station", "Bank Underground Station",
];

const best = (names, q) => { const r = matchNames(names, q); return r.length ? names[r[0]] : null; };

test("normalizeName strips the generic words players never say", () => {
  assert.equal(normalizeName("Waterloo Station"), "waterloo");
  assert.equal(normalizeName("Bank Underground Station"), "bank");
  assert.equal(normalizeName("Dadar Railway Station"), "dadar");
});

test("normalizeName folds accents — the seeker types ASCII, OSM stores diacritics", () => {
  assert.equal(normalizeName("São Paulo"), "sao paulo");
  assert.equal(normalizeName("Zürich HB"), "zurich hb");
  assert.equal(normalizeName("Gare de Lyon"), "gare de lyon"); // "gare" IS how people say it
});

test("normalizeName drops parenthetical qualifiers and punctuation", () => {
  assert.equal(normalizeName("Shinjuku Station (South Exit)"), "shinjuku");
  assert.equal(normalizeName("King's Cross St. Pancras"), "king s cross st pancras");
});

test("a name made entirely of generic words still survives", () => {
  // Stripping noise would empty these; the fallback keeps them matchable.
  assert.equal(normalizeName("Station"), "station");
  assert.equal(normalizeName("Metro Station"), "metro station");
  assert.notEqual(normalizeName("Station"), "");
});

test("designators that identify DIFFERENT stations are not stripped", () => {
  // Measured against live OSM: Mumbai has both "Bandra" and "Bandra Terminus", which are
  // different stations on different services. Stripping "terminus" as noise collapsed them
  // into one name and made typing "Bandra" rank the Terminus first. Over-stripping silently
  // conflates distinct places — the one thing this matcher must never do.
  assert.notEqual(normalizeName("Bandra Terminus"), normalizeName("Bandra"));
  assert.notEqual(normalizeName("Clapham Junction"), normalizeName("Clapham"));
  assert.notEqual(normalizeName("Box Halt"), normalizeName("Box"));
});

test("the real Mumbai case: 'Bandra' resolves to Bandra, not Bandra Terminus", () => {
  // Names taken verbatim from a live Overpass query of the Mumbai bbox.
  const mumbai = [
    "Bandra Terminus", "Bandra", "Bandra Kurla Complex (BKC)", "Bandra Colony",
    "Bandra Reclamation Bus Station", "Bandra East", "Bandra Bus Station (W)",
  ];
  assert.equal(best(mumbai, "Bandra"), "Bandra");
  assert.equal(best(mumbai, "Bandra Terminus"), "Bandra Terminus");
});

test("the headline case: typing 'Waterloo' finds Waterloo Station", () => {
  assert.equal(best(LONDON, "Waterloo"), "Waterloo Station");
});

test("an exact match outranks a longer name containing it", () => {
  // "Waterloo" must not resolve to "Waterloo East" — both match, one is right.
  const ranked = matchNames(LONDON, "Waterloo").map((i) => LONDON[i]);
  assert.equal(ranked[0], "Waterloo Station");
  assert.ok(ranked.includes("Waterloo East Station"), "the other match is still offered");
});

test("a prefix typo still resolves", () => {
  assert.equal(best(LONDON, "waterlo"), "Waterloo Station");
  assert.equal(best(LONDON, "padd"), "Paddington Station");
});

test("case and punctuation are irrelevant", () => {
  assert.equal(best(LONDON, "KINGS CROSS"), "King's Cross St. Pancras");
  assert.equal(best(LONDON, "kings cross"), "King's Cross St. Pancras");
});

test("no local hit returns empty, so the caller falls through to a real search", () => {
  // This is the contract that keeps Google reachable for genuinely missing places.
  assert.deepEqual(matchNames(LONDON, "Gare du Nord"), []);
  assert.deepEqual(matchNames(LONDON, "zzzz"), []);
});

test("an empty or whitespace query never matches everything", () => {
  assert.deepEqual(matchNames(LONDON, ""), []);
  assert.deepEqual(matchNames(LONDON, "   "), []);
  assert.deepEqual(matchNames(LONDON, null), []);
});

test("typing a generic word alone does not match every station", () => {
  // "station" is stripped as noise, so it cannot silently select the whole board.
  assert.deepEqual(matchNames(LONDON, "station"), []);
});

test("unnamed candidates are skipped rather than throwing", () => {
  const withGaps = ["Waterloo Station", null, undefined, "", "Euston Station"];
  assert.equal(best(withGaps, "euston"), "Euston Station");
});

test("multi-word queries match on all words present", () => {
  assert.equal(best(LONDON, "london bridge"), "London Bridge Station");
});
