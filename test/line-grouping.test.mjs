// F1: OSM route relations are SERVICES, not lines. DC's Red Line is several relations
// (one per direction); Mumbai's Western Line is four (fast/slow × both directions) on the
// same rails. Offering those as separate choices asks the seeker to pick between two options
// that mean the same thing, and partitions between geometry that is identical.
//
// The fixture is a REAL Overpass response for Washington DC — deliberately, because §F3 names
// DC as the city where the naive version broke in production ("the whole DC Metro comes back
// as one line"). If that shape ever returns, this suite is where it shows up.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeLines } from "../overpass-lines.js";
import { groupIntoLines, baseLineName } from "../src/lines.js";

const raw = JSON.parse(readFileSync(new URL("./fixtures/overpass-metro-washington-dc.json", import.meta.url), "utf8"));
const DC = normalizeLines("metro", raw);

test("baseLineName strips OSM's direction suffixes, whichever convention was used", () => {
  assert.equal(baseLineName("WMATA Red Line: Glenmont → Shady Grove"), "WMATA Red Line");
  assert.equal(baseLineName("Line 1 (Versova → Ghatkopar)"), "Line 1");
  assert.equal(baseLineName("東京メトロ銀座線 : 浅草→渋谷"), "東京メトロ銀座線");
  assert.equal(baseLineName("S85: Flughafen BER => S Frohnau"), "S85");
  assert.equal(baseLineName("Rayburn Line Northbound"), "Rayburn Line", "direction as a trailing word");
  assert.equal(baseLineName("Russell Line Southbound"), "Russell Line");
  assert.equal(baseLineName("Northern"), "Northern", "a name with no suffix is left alone");
  assert.equal(baseLineName("Westbourne Park Line"), "Westbourne Park Line", "only strips a WHOLE trailing word");
  // Never return empty — a nameless choice is unpickable.
  assert.equal(baseLineName(": only a suffix"), ": only a suffix");
  assert.equal(baseLineName(""), "");
});

test("DC's real metro data groups WMATA into its six lines", () => {
  const lines = groupIntoLines(DC);
  const labels = lines.map((l) => l.label);
  const wmata = labels.filter((l) => /WMATA/.test(l));
  assert.equal(wmata.length, 6, `expected 6 WMATA lines, got ${wmata.length}: ${labels.join(", ")}`);
  for (const colour of ["Red", "Blue", "Orange", "Yellow", "Green", "Silver"]) {
    assert.ok(wmata.some((l) => l.includes(colour)), `missing the ${colour} Line — got ${wmata.join(", ")}`);
  }
});

test("DC's Capitol people-movers survive as choices — deliberately, and grouped", () => {
  // route=light_rail, network="Capitol Subway System": ~200m people-movers INSIDE the
  // Congressional office buildings. Not a metro line anyone hides near.
  //
  // They are NOT filtered out, and that is a decision, not an oversight. Filtering by
  // `network` is per-city tuning of exactly the kind the admin_level spike proved does not
  // generalise; filtering by LENGTH would drop a real line that merely clips the board's
  // corner, which is the false-elimination class §A exists to remove. Instead they are
  // offered and the seeker unticks them in _assembleCandidates — which is why that flow's
  // escape hatch (E7) matters. The one thing owed is that they arrive as 3 lines, not 6.
  const labels = groupIntoLines(DC).map((l) => l.label);
  const capitol = labels.filter((l) => /Rayburn|Russell|Dirksen/.test(l));
  assert.deepEqual(capitol.sort(), ["Dirksen-Hart Line", "Rayburn Line", "Russell Line"],
    `expected 3 grouped Capitol lines, got ${capitol.join(", ")}`);
});

test("the mega-relation shape §F3 warns about is not present — and this is where it'd show", () => {
  // F3: "Some networks tag the entire system as one relation — the whole DC Metro comes back
  // as 'one line', so every station matches every other and the question never discriminates."
  // Measured 2026-07-16 across 8 cities: does not reproduce. Pinned here so a regression in
  // the data (or in the grouping key) surfaces as a test failure rather than a dead card.
  const lines = groupIntoLines(DC);
  assert.ok(lines.length >= 2, "a single group cannot discriminate — the card would be dead");
  const biggest = Math.max(...lines.map((l) => l.wayIds.length));
  const total = lines.reduce((n, l) => n + l.wayIds.length, 0);
  assert.ok(biggest < total * 0.9, `one group owns ${biggest}/${total} ways — looks like a mega-relation`);
});

test("both directions of a line collapse into one choice", () => {
  // The fixture has "Red Line: Glenmont → Shady Grove" AND "Red Line: Shady Grove → Glenmont".
  const relNames = DC.lines.map((l) => l.name);
  const red = relNames.filter((n) => /Red Line/.test(n));
  assert.ok(red.length >= 2, `fixture needs both Red directions to prove this; got ${red.length}`);

  const lines = groupIntoLines(DC);
  const redGroups = lines.filter((l) => /Red/.test(l.label));
  assert.equal(redGroups.length, 1, `both Red directions must be ONE choice, got ${redGroups.length}`);
});

test("shared track is counted once per line, not once per service", () => {
  const lines = groupIntoLines(DC);
  for (const l of lines) {
    assert.equal(new Set(l.wayIds).size, l.wayIds.length, `${l.label} lists a way twice`);
    assert.equal(l.paths.length, l.wayIds.filter((id) => DC.ways[id]).length);
    for (const p of l.paths) assert.ok(p.length >= 2, "a 1-point path cannot be nearest to anything");
  }
});

test("every group carries real geometry", () => {
  for (const l of groupIntoLines(DC)) {
    assert.ok(l.paths.length > 0, `${l.label} has no geometry`);
    const [lat, lng] = l.paths[0][0];
    assert.ok(lat > 38 && lat < 39.5, `lat ${lat} not in DC — axes may be swapped`);
    assert.ok(lng > -78 && lng < -76, `lng ${lng} not in DC — axes may be swapped`);
  }
});

// ---- synthetic edge cases the real fixture doesn't contain -----------------------------

test("relations with no ref fall back to the name", () => {
  // Measured: DC 6/145 and Mumbai 3/61 relations carry no ref, so this path is live.
  const data = {
    lines: [
      { name: "Ghost Line: A => B", ref: null, wayIds: [1] },
      { name: "Ghost Line: B => A", ref: null, wayIds: [2] },
    ],
    ways: { 1: [[38.9, -77.0], [38.91, -77.0]], 2: [[38.9, -77.0], [38.91, -77.0]] },
  };
  const lines = groupIntoLines(data);
  assert.equal(lines.length, 1, "the name should still collapse both directions");
  assert.equal(lines[0].label, "Ghost Line");
});

test("labels that collide get their ref appended — a blind choice is worse than a noisy one", () => {
  const data = {
    lines: [
      { name: "Metro Line: A => B", ref: "1", wayIds: [1] },
      { name: "Metro Line: C => D", ref: "2", wayIds: [2] },
    ],
    ways: { 1: [[38.9, -77.0], [38.91, -77.0]], 2: [[38.9, -76.9], [38.91, -76.9]] },
  };
  const labels = groupIntoLines(data).map((l) => l.label).sort();
  assert.deepEqual(labels, ["Metro Line (1)", "Metro Line (2)"]);
});

test("a group whose geometry is all off-board is dropped, not offered empty", () => {
  const data = { lines: [{ name: "Absent Line", ref: "Z", wayIds: [99] }], ways: {} };
  assert.deepEqual(groupIntoLines(data), []);
});

test("an empty payload groups to nothing rather than throwing", () => {
  for (const empty of [{ lines: [], ways: {} }, {}, null]) {
    assert.deepEqual(groupIntoLines(empty), []);
  }
});
