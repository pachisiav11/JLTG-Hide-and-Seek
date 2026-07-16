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
  RAIL_ROUTE_TYPES, BORDER_LEVELS, DEFAULT_BORDER_LEVEL,
} from "../overpass-lines.js";

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
  assert.throws(() => buildLinesQuery("streets", BBOX), (e) => e.badRequest === true);
  assert.deepEqual(LINE_KINDS, ["rail", "coastline", "border"]);
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
