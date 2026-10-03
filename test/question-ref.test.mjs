// The seekers' reference → text → the hider's phone. Playtest 2's coastline question failed
// because the hider could not see the line the seekers had drawn; these tests pin that the line
// (or POI list, or region) that leaves the seekers' phone is the one that arrives, with the
// seekers' side of the question and NOTHING of the hider's answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCustomReference, isShareableStep, buildQuestionRef, refFromStep, seekerFromStep,
  questionRefText, parseQuestionRef, refMatchesCard, describeReference, describeSeekerSide, REF_KIND,
} from "../src/question-ref.js";

const POIS = [
  { lat: 19.0761234567, lng: 72.8771234567, name: "Museum A" },
  { lat: 19.0812, lng: 72.8655, name: "Museum B" },
  { lat: 19.0633, lng: 72.8899, name: "Museum C" },
];
const LINE = { type: "LineString", coordinates: [[72.80, 19.00], [72.82, 19.05], [72.85, 19.10]] };
const RING = [[19.0, 72.8], [19.0, 72.9], [19.1, 72.9], [19.1, 72.8]];
const DRAWN_LINES = [
  { id: "ln_0_x", label: "Harbour path", coords: [{ lat: 19.0, lng: 72.8 }, { lat: 19.05, lng: 72.85 }] },
  { id: "ln_1_y", label: "Ridge path", coords: [{ lat: 19.1, lng: 72.8 }, { lat: 19.12, lng: 72.86 }, { lat: 19.15, lng: 72.9 }] },
];
const STATIONS = [
  { id: "osm:1", name: "Dadar", lat: 19.018, lng: 72.843 },
  { id: "manual:abc", name: "Station 2", lat: 19.03, lng: 72.85 },
];

// One committed step per shareable variant, shaped exactly as layers.js commits them.
const STEPS = {
  measuringPoints: { tool: "measuring", inputs: { refType: "points", refLabel: "Museum", refCard: "museum", refGeometry: { type: "MultiPoint", coordinates: POIS.map((p) => [p.lng, p.lat]) }, refFeatures: POIS, distance: 1240 }, answer: { side: "in" } },
  measuringLine: { tool: "measuring", inputs: { refType: "line", refLabel: "Coastline", refCard: "coastline", refGeometry: LINE, distance: 830 }, answer: { side: "out" } },
  measuringArea: { tool: "measuring", inputs: { refType: "area", refLabel: "Body of Water", refCard: "water", refGeometry: { type: "Polygon", coordinates: [[...RING.map(([a, b]) => [b, a]), [RING[0][1], RING[0][0]]]] }, distance: 400 }, answer: { side: "in" } },
  measuringRegion: { tool: "measuring", inputs: { refType: "region", refLabel: "Sea Level", refCard: "sea_level", ring: RING }, answer: { inside: true } },
  matchingNearest: { tool: "matching", inputs: { mode: "nearest", category: "museum", categoryLabel: "Museum", features: POIS }, answer: { featureIndex: 1, keep: true } },
  matchingNameLength: { tool: "matching", inputs: { mode: "nameLength", category: "name_length", categoryLabel: "station name length", features: POIS.map((p) => ({ ...p, len: 7 })) }, answer: { length: 7, comparison: "shorter", match: false } },
  matchingStationLine: { tool: "matching", inputs: { mode: "stationLine", category: "station_line", categoryLabel: "Station's Line", stations: STATIONS, memberIds: STATIONS.map((s) => s.id), radiusM: 800, lineLabel: "Western Line" }, answer: { match: true } },
  matchingDrawnLines: { tool: "matching", inputs: { mode: "nearestLine", category: "street", categoryLabel: "Street or Path", lines: DRAWN_LINES, source: "drawn" }, answer: { lineId: "ln_1_y", match: false } },
  matchingRegion: { tool: "matching", inputs: { mode: "region", category: "admin2", categoryLabel: "2nd Admin. Division", ring: RING }, answer: { inside: false } },
  tentaclesPoints: { tool: "tentacles", inputs: { category: "museum", categoryLabel: "Museums", radius: 2000, features: POIS, center: { lat: 19.07, lng: 72.87 } }, answer: { featureIndex: 2 } },
};

const roundTrip = (step) => parseQuestionRef(questionRefText(refFromStep(step)));

test("every seeker-chosen reference is shareable", () => {
  for (const [name, step] of Object.entries(STEPS)) assert.ok(isShareableStep(step), name);
});

test("auto-sourced OSM lines and reference-free tools are NOT shareable", () => {
  assert.equal(isCustomReference("measuring", { refType: "line", refSource: "osm", refGeometry: LINE }), false);
  assert.equal(isCustomReference("matching", { mode: "nearestLine", source: "osm", lines: DRAWN_LINES }), false);
  assert.equal(isCustomReference("tentacles", { lines: [{ id: "a", label: "Line 1", paths: [[[19, 72], [19.1, 72.1]]] }], features: undefined, radius: 25000 }), false);
  assert.equal(isShareableStep({ tool: "radar", inputs: { center: { lat: 1, lng: 2 }, radius: 500 } }), false);
  assert.equal(isShareableStep({ tool: "thermometer", inputs: { a: {}, b: {} } }), false);
  assert.throws(() => buildQuestionRef({ tool: "measuring", inputs: { refType: "line", refSource: "osm", refGeometry: LINE } }), /looked up automatically/);
});

test("measuring points: places, their names and numbering, and the seekers' distance arrive", () => {
  const ref = roundTrip(STEPS.measuringPoints);
  assert.equal(ref.tool, "measuring"); assert.equal(ref.variant, "points"); assert.equal(ref.card, "museum");
  assert.equal(ref.title, "Measuring · Museum");
  assert.deepEqual(ref.pois.map((p) => [p.n, p.name]), [[1, "Museum A"], [2, "Museum B"], [3, "Museum C"]]);
  // Rounded to 6 dp, not truncated or shifted.
  assert.equal(ref.pois[0].lat, 19.076123);
  assert.equal(ref.pois[0].lng, 72.877123);
  assert.equal(ref.seeker.distanceM, 1240);
});

test("measuring line: the seekers' drawn coastline arrives vertex for vertex", () => {
  const ref = roundTrip(STEPS.measuringLine);
  assert.equal(ref.lines.length, 1);
  assert.deepEqual(ref.lines[0].paths[0], LINE.coordinates.map(([lng, lat]) => ({ lat, lng })));
  assert.equal(ref.seeker.distanceM, 830);
});

test("measuring area and sea-level region arrive as polygons", () => {
  const area = roundTrip(STEPS.measuringArea);
  assert.equal(area.polygons.length, 1); assert.equal(area.polygons[0].role, "area");
  assert.deepEqual(area.polygons[0].ring, RING);
  assert.equal(area.seeker.distanceM, 400);
  const region = roundTrip(STEPS.measuringRegion);
  assert.equal(region.polygons[0].role, "region");
  assert.deepEqual(region.polygons[0].ring, RING);
  assert.deepEqual(region.seeker, {}, "the region IS the seekers' side; no extra field");
});

test("matching nearest: the seekers' own nearest travels, numbered as on their map", () => {
  const ref = roundTrip(STEPS.matchingNearest);
  assert.equal(ref.seeker.nearest, 2);
  assert.match(describeSeekerSide(ref), /Seekers' nearest: #2 Museum B/);
});

test("matching name length, station's line, drawn lines and region", () => {
  assert.equal(roundTrip(STEPS.matchingNameLength).seeker.nameLength, 7);
  const sl = roundTrip(STEPS.matchingStationLine);
  assert.deepEqual(sl.pois.map((p) => p.name), ["Dadar", "Station 2"]);
  assert.equal(sl.lineLabel, "Western Line"); assert.equal(sl.hidingRadiusM, 800);
  const dl = roundTrip(STEPS.matchingDrawnLines);
  assert.deepEqual(dl.lines.map((l) => [l.id, l.name, l.paths[0].length]), [["ln_0_x", "Harbour path", 2], ["ln_1_y", "Ridge path", 3]]);
  assert.equal(dl.seeker.nearestLine, "ln_1_y");
  const rg = roundTrip(STEPS.matchingRegion);
  assert.equal(rg.polygons[0].role, "region");
});

test("tentacles: the ticked places plus the seekers' centre and reach", () => {
  const ref = roundTrip(STEPS.tentaclesPoints);
  assert.equal(ref.pois.length, 3);
  assert.deepEqual(ref.center, { lat: 19.07, lng: 72.87 });
  assert.equal(ref.radiusM, 2000);
  assert.deepEqual(ref.seeker, {});
});

test("the HIDER's answer never travels — flipping it changes nothing in the message", () => {
  const flips = {
    measuringPoints: { side: "out" }, measuringLine: { side: "in" }, measuringRegion: { inside: false },
    matchingNearest: { featureIndex: 1, keep: false }, matchingStationLine: { match: false },
    matchingDrawnLines: { lineId: "ln_1_y", match: true }, matchingRegion: { inside: true },
    tentaclesPoints: { featureIndex: 0 }, matchingNameLength: { length: 7, comparison: "longer", match: false },
  };
  for (const [name, answer] of Object.entries(flips)) {
    const a = refFromStep(STEPS[name], { sentAt: 0 });
    const b = refFromStep({ ...STEPS[name], answer }, { sentAt: 0 });
    assert.deepEqual(a, b, `${name}: the hider's answer leaked into the message`);
  }
  // And the seeker block never carries an answer-shaped key.
  for (const step of Object.values(STEPS)) {
    const keys = Object.keys(refFromStep(step).jltg.seeker);
    for (const k of keys) assert.ok(["distanceM", "nearest", "nameLength", "nearestLine"].includes(k), k);
  }
});

test("seekerFromStep reads the seekers' entries only", () => {
  assert.deepEqual(seekerFromStep(STEPS.matchingNearest), { nearest: 2 });
  assert.deepEqual(seekerFromStep(STEPS.tentaclesPoints), {});
  assert.deepEqual(seekerFromStep(STEPS.matchingRegion), {});
});

test("an invalid seekers' side is dropped, not sent as junk", () => {
  const fc = buildQuestionRef({ tool: "measuring", inputs: STEPS.measuringLine.inputs, seeker: { distanceM: -5 } });
  assert.deepEqual(fc.jltg.seeker, {});
  const fc2 = buildQuestionRef({ tool: "matching", inputs: STEPS.matchingNearest.inputs, seeker: { nearest: 99 } });
  assert.deepEqual(fc2.jltg.seeker, {});
  assert.match(describeSeekerSide(parseQuestionRef(questionRefText(fc))), /didn't include their distance/);
});

test("the message is self-describing and the parser tolerates the chat around it", () => {
  const text = questionRefText(refFromStep(STEPS.measuringLine));
  assert.match(text.split("\n")[0], /^JLTG question for the hider — Measuring · Coastline\. Paste/);
  // A chat app may add a forwarded-header line and trailing whitespace.
  const ref = parseQuestionRef(`Forwarded\n\n${text}\n\n  `);
  assert.equal(ref.title, "Measuring · Coastline");
  // The JSON part is valid GeoJSON on its own.
  const fc = JSON.parse(text.slice(text.indexOf("{")));
  assert.equal(fc.type, "FeatureCollection");
  assert.equal(fc.jltg.kind, REF_KIND);
});

test("refusals: each bad paste gets a reason, and a play area is redirected", () => {
  assert.throws(() => parseQuestionRef(""), /Nothing pasted/);
  assert.throws(() => parseQuestionRef("hello there"), /isn't a question from the seekers/);
  const good = questionRefText(refFromStep(STEPS.measuringPoints));
  assert.throws(() => parseQuestionRef(good.slice(0, good.length - 40)), /cut off or edited/);
  assert.throws(() => parseQuestionRef(JSON.stringify({ type: "FeatureCollection", jltg: { kind: "play-area" }, features: [] })), /Zones ▸ ⇩ Import area/);
  assert.throws(() => parseQuestionRef(JSON.stringify({ type: "Polygon", coordinates: [] })), /isn't a question from the seekers/);
  const future = JSON.parse(good.slice(good.indexOf("{"))); future.jltg.v = 9;
  assert.throws(() => parseQuestionRef(JSON.stringify(future)), /different version/);
  const broken = JSON.parse(good.slice(good.indexOf("{"))); broken.features[0].geometry.coordinates = [500, 19];
  assert.throws(() => parseQuestionRef(JSON.stringify(broken)), /broken coordinate/);
  const empty = JSON.parse(good.slice(good.indexOf("{"))); empty.features = [];
  assert.throws(() => parseQuestionRef(JSON.stringify(empty)), /no line or places/);
  const huge = JSON.parse(good.slice(good.indexOf("{"))); huge.features = Array.from({ length: 2001 }, () => huge.features[0]);
  assert.throws(() => parseQuestionRef(JSON.stringify(huge)), /too many/);
});

test("refMatchesCard: by card id, falling back to the label for older steps", () => {
  const ref = roundTrip(STEPS.measuringLine);
  assert.ok(refMatchesCard(ref, { tool: "measuring", cardId: "coastline" }));
  assert.ok(!refMatchesCard(ref, { tool: "measuring", cardId: "water" }));
  assert.ok(!refMatchesCard(ref, { tool: "matching", cardId: "coastline" }));
  const legacy = { ...STEPS.measuringLine, inputs: { ...STEPS.measuringLine.inputs, refCard: undefined } };
  const lref = roundTrip(legacy);
  assert.equal(lref.card, null);
  assert.ok(refMatchesCard(lref, { tool: "measuring", cardId: "coastline", cardLabel: "Coastline" }));
  assert.ok(!refMatchesCard(lref, { tool: "measuring", cardId: "water", cardLabel: "Body of Water" }));
});

test("describeReference counts what arrived", () => {
  assert.equal(describeReference(roundTrip(STEPS.matchingNearest)), "3 places");
  assert.equal(describeReference(roundTrip(STEPS.measuringLine)), "1 line");
  assert.equal(describeReference(roundTrip(STEPS.matchingDrawnLines)), "2 lines");
  assert.equal(describeReference(roundTrip(STEPS.measuringArea)), "1 area");
  assert.equal(describeReference(roundTrip(STEPS.matchingRegion)), "1 region");
});

test("looksLikeQuestionRef spots a question in the wrong paste box, even truncated", async () => {
  const { looksLikeQuestionRef } = await import("../src/question-ref.js");
  const text = questionRefText(refFromStep(STEPS.matchingRegion));
  assert.ok(looksLikeQuestionRef(text));
  assert.ok(looksLikeQuestionRef(text.slice(0, 200)));
  assert.ok(!looksLikeQuestionRef('{"type":"FeatureCollection","jltg":{"kind":"play-area"},"features":[]}'));
  assert.ok(!looksLikeQuestionRef("19.09,72.82\n19.09,72.84\n19.11,72.84"));
});
