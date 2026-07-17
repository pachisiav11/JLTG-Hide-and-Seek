// G1: shaping Overpass linear geometry into what the map and §F4 need.
//
// The fixtures are REAL Overpass responses (small Mumbai bboxes, captured 2026-07-16), not
// hand-written objects. That matters: the real shape has things an invented fixture wouldn't,
// notably relation members of type "node" (role:"stop") mixed in with the ways, and member
// lists where most refs point outside the bbox and must not join.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildLinesQuery, normalizeLines, bboxIsValid, LINE_KINDS,
  RAIL_ROUTE_TYPES, METRO_ROUTE_TYPES, BORDER_LEVELS, DEFAULT_BORDER_LEVEL,
} from "../overpass-lines.js";
// Shaping is pure data and needs no turf — except to assert the ONE thing that actually broke
// in a live game: that what this module emits is measurable by the consumer it feeds.
import { turf } from "./helpers/turf-env.mjs";

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/overpass-${n}.json`, import.meta.url), "utf8"));
const RAIL = fixture("rail-mumbai");
const COAST = fixture("coastline-mumbai");
const BBOX = "18.89,72.76,19.28,73.02";

// ---- queries ---------------------------------------------------------------------------

test("the rail query recurses from the NAMED set — the silent-zero regression", () => {
  const q = buildLinesQuery("rail", BBOX);
  // Measured: `->.r` followed by bare `way(r)` reads the empty default set and returns 0 ways
  // in Mumbai AND Berlin, with HTTP 200 and valid JSON so nothing raises. It would draw an
  // empty rail layer on every board forever. This is a string assertion because reproducing
  // it needs live Overpass; the cost of regressing is the entire feature, silently.
  assert.match(q, /way\(r\.r\)/, "must recurse from the named set .r");
  assert.doesNotMatch(q, /way\(r\)(?!\.)/, "bare way(r) reads the default set, which ->.r left empty");
  assert.match(q, /->\.r/);
});

test("the rail query clips ways to the bbox and asks for geometry", () => {
  const q = buildLinesQuery("rail", BBOX);
  // Unclipped, Berlin is 34MB/33.9s against a 45s timeout — the clip is correctness, not speed.
  assert.ok(q.includes(`way(r.r)(${BBOX})`), `way step must carry the bbox:\n${q}`);
  assert.match(q, /out geom;/, "out center tags collapses ways to a point — useless for lines");
  assert.match(q, /\.r out body;/, "need relation tags + member ids to name the geometry");
  for (const t of RAIL_ROUTE_TYPES) assert.ok(q.includes(t), `route type ${t} missing`);
});

test("the border query defaults to admin_level 4, the one level measured universal", () => {
  assert.equal(DEFAULT_BORDER_LEVEL, 4);
  assert.match(buildLinesQuery("border", BBOX), /\["admin_level"="4"\]/);
  assert.match(buildLinesQuery("border", BBOX, { level: BORDER_LEVELS.country }), /\["admin_level"="2"\]/);
});

test("the coastline query skips the relation step it has no use for", () => {
  const q = buildLinesQuery("coastline", BBOX);
  assert.match(q, /way\["natural"="coastline"\]/);
  assert.doesNotMatch(q, /out body/, "coastline is tagged on ways; there is no relation to name");
});

test("an unknown kind is a 400, not a silent empty result", () => {
  // "streets" is the named exclusion from the brief ("everything except streets"), so it is
  // the right probe: it must be a loud 400, never an empty answer that reads as "none here".
  assert.throws(() => buildLinesQuery("streets", BBOX), (e) => e.badRequest === true);
  assert.deepEqual(LINE_KINDS, ["rail", "metro", "coastline", "highspeed", "border"]);
  // Every advertised kind must actually build — an entry here that throws would 400 a card
  // at the point of use, in a live game.
  for (const k of LINE_KINDS) assert.ok(buildLinesQuery(k, BBOX).includes("out geom"), `${k} must build a geometry query`);
});

test("the metro kind excludes train and tram — the Metro Lines card means neither", () => {
  const q = buildLinesQuery("metro", BBOX);
  assert.deepEqual(METRO_ROUTE_TYPES, ["subway", "light_rail", "monorail"]);
  for (const t of METRO_ROUTE_TYPES) assert.ok(q.includes(t), `metro should include ${t}`);
  // `train` is intercity/suburban: in DC and NYC the single biggest group is 60+ relations of
  // "Amtrak Northeast Regional". `tram` is streets. Both are noise on this card — and
  // excluding train is also what keeps `ref` meaning the LINE rather than the operator
  // (Tokyo's KS merges two real lines; Paris's H merges 32 Transilien services).
  assert.doesNotMatch(q, /\btrain\b/, "route=train is intercity rail, not metro");
  assert.doesNotMatch(q, /\btram\b/, "route=tram runs on streets");
  // Same shape as rail otherwise — the silent-zero bug must not sneak back in via a new kind.
  assert.match(q, /way\(r\.r\)/);
  assert.ok(q.includes(`way(r.r)(${BBOX})`));
});

test("rail still includes train and tram — metro is a narrowing, not a replacement", () => {
  const q = buildLinesQuery("rail", BBOX);
  assert.match(q, /\btrain\b/);
  assert.match(q, /\btram\b/);
});

test("bboxIsValid rejects the shapes that would silently return nothing", () => {
  assert.ok(bboxIsValid(BBOX));
  assert.ok(!bboxIsValid(""), "empty");
  assert.ok(!bboxIsValid("1,2,3"), "three numbers");
  assert.ok(!bboxIsValid("a,b,c,d"), "non-numeric");
  assert.ok(!bboxIsValid("19.28,72.76,18.89,73.02"), "S above N: Overpass returns an empty set, not an error");
  assert.ok(!bboxIsValid("18.89,73.02,19.28,72.76"), "W east of E");
  assert.ok(!bboxIsValid("-91,0,10,10"), "off-planet latitude");
});

// ---- shaping ---------------------------------------------------------------------------

test("real rail data shapes into named lines with joined geometry", () => {
  const out = normalizeLines("rail", RAIL);
  assert.ok(out.counts.lines > 0, "expected lines");
  assert.ok(out.counts.ways > 0, "expected ways");
  assert.equal(out.counts.ways, Object.keys(out.ways).length);

  // The lines the ask is actually about: Mumbai's suburban locals, which Google's transit
  // layer does not draw.
  const names = out.lines.map((l) => l.name).join(" | ");
  assert.match(names, /Western Line/, `expected the Western local; got: ${names.slice(0, 200)}`);

  for (const l of out.lines) {
    assert.ok(l.name && typeof l.name === "string", "every line is named");
    assert.ok(l.wayIds.length > 0, "a line with no geometry in the box must be dropped, not empty");
    for (const id of l.wayIds) assert.ok(out.ways[id], `line "${l.name}" references way ${id} with no geometry`);
  }
});

test("member NODES are not mistaken for ways", () => {
  // Real route relations list their stops as members: {type:"node", role:"stop"}. A filter on
  // presence rather than type would emit those refs as way ids pointing at nothing.
  const nodeRefs = new Set();
  for (const el of RAIL.elements) {
    if (el.type !== "relation") continue;
    for (const m of el.members || []) if (m.type === "node") nodeRefs.add(m.ref);
  }
  assert.ok(nodeRefs.size > 0, "fixture should contain member nodes, else this proves nothing");

  const out = normalizeLines("rail", RAIL);
  for (const l of out.lines) {
    for (const id of l.wayIds) assert.ok(!nodeRefs.has(id), `way id ${id} is actually a member node`);
  }
});

test("geometry is stored once, not repeated per line that shares the track", () => {
  const out = normalizeLines("rail", RAIL);
  const totalRefs = out.lines.reduce((n, l) => n + l.wayIds.length, 0);
  // Mumbai's fast/slow/both-direction relations share rails, so refs should exceed unique ways.
  // If these were equal the sharing wouldn't be exercised and this test would prove nothing.
  assert.ok(totalRefs > out.counts.ways,
    `fixture should have shared track (refs ${totalRefs} vs ways ${out.counts.ways})`);
  // Every id appears once as a key regardless of how many lines cite it — that is what lets
  // the render draw each physical track once with a uniform stroke.
  const ids = Object.keys(out.ways);
  assert.equal(new Set(ids).size, ids.length);
});

test("coordinates are [lat,lng] rounded to 5dp", () => {
  const out = normalizeLines("rail", RAIL);
  const coords = Object.values(out.ways)[0];
  for (const [lat, lng] of coords.slice(0, 40)) {
    assert.ok(lat > 18 && lat < 20, `lat ${lat} out of Mumbai range — axes may be swapped`);
    assert.ok(lng > 72 && lng < 74, `lng ${lng} out of Mumbai range — axes may be swapped`);
    assert.equal(lat, Math.round(lat * 1e5) / 1e5, `${lat} not rounded to 5dp`);
    assert.equal(lng, Math.round(lng * 1e5) / 1e5, `${lng} not rounded to 5dp`);
  }
});

test("relations whose track is all outside the box are dropped, not emitted empty", () => {
  // Rebuild with geometry the relations cannot possibly reference.
  const noJoin = { elements: RAIL.elements.map((el) => (el.type === "way" ? { ...el, id: el.id + 1e12 } : el)) };
  const out = normalizeLines("rail", noJoin);
  assert.deepEqual(out.lines, [], "no relation can join, so no line has visible geometry");
  assert.ok(out.counts.ways > 0, "the ways themselves still exist");
});

test("5dp rounding must not leave duplicate vertices — turf throws on them", () => {
  // Found live on a Berlin board. r5 rounds to ~1.1 m, which collapses vertices that were
  // closer than that into EXACT duplicates. turf.pointToLineDistance then throws
  // "coordinates must contain numbers" on the zero-length segment — so `candidateLines`,
  // which measures every line, died on the whole set. Only 4 of 282 real Berlin ways carry
  // one; that 1% took down 100% of the card, and layers.js reported it as "Couldn't load
  // metro lines" — a code bug wearing an outage's clothes.
  const json = { elements: [{
    type: "way", id: 1,
    geometry: [
      { lat: 52.549450, lon: 13.392560 },
      { lat: 52.549451, lon: 13.392561 }, // ~0.1 m away — rounds onto the point above
      { lat: 52.549452, lon: 13.392559 }, // and again
      { lat: 52.548000, lon: 13.391000 },
    ],
  }] };
  const { ways } = normalizeLines("coastline", json);
  const coords = ways[1];
  assert.ok(coords, "the way must survive — it is ~170 m long, only its first 3 nodes collide");
  for (let i = 1; i < coords.length; i++) {
    assert.ok(
      coords[i][0] !== coords[i - 1][0] || coords[i][1] !== coords[i - 1][1],
      `vertex ${i} repeats vertex ${i - 1} — turf cannot measure this line`,
    );
  }
  // The real assertion: the output must be usable by the consumer that was breaking.
  const line = turf.lineString(coords.map(([lat, lng]) => [lng, lat]));
  assert.doesNotThrow(
    () => turf.pointToLineDistance(turf.point([13.38, 52.52]), line, { units: "meters" }),
    "the whole point: candidateLines must be able to measure the line it is handed",
  );
});

test("a way that rounds away to a single point is dropped, not emitted broken", () => {
  // A sub-metre way collapses to one vertex once duplicates go. The existing length check
  // owns that — but it has to run AFTER the dedup, or it never sees the collapse.
  const json = { elements: [{
    type: "way", id: 2,
    geometry: [{ lat: 52.5494500, lon: 13.3925600 }, { lat: 52.5494501, lon: 13.3925601 }],
  }] };
  const { ways, counts } = normalizeLines("coastline", json);
  assert.equal(ways[2], undefined, "a ~1 cm way cannot draw or be measured");
  assert.equal(counts.ways, 0);
});

test("1-point ways are dropped — they cannot draw", () => {
  const stub = { elements: [{ type: "way", id: 1, geometry: [{ lat: 19, lon: 72 }] }] };
  assert.equal(normalizeLines("coastline", stub).counts.ways, 0);
});

test("real coastline shapes into one line with no relation step", () => {
  const out = normalizeLines("coastline", COAST);
  assert.ok(out.counts.ways > 0);
  assert.equal(out.lines.length, 1, "one synthetic line keeps the shape uniform across kinds");
  assert.equal(out.lines[0].name, "Coastline");
  assert.equal(out.lines[0].wayIds.length, out.counts.ways, "the one line owns every way");
});

test("an empty Overpass answer shapes cleanly rather than throwing", () => {
  // The busy-endpoint and no-data cases both land here; they must be distinguishable by
  // counts, not by an exception from the shaper.
  for (const empty of [{ elements: [] }, {}, null]) {
    const out = normalizeLines("rail", empty);
    assert.deepEqual(out.lines, []);
    assert.deepEqual(out.counts, { lines: 0, ways: 0, vertices: 0 });
  }
});
