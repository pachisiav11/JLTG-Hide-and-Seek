// Play-area sharing: the boundary leaves one phone as GeoJSON text and must arrive on another
// as the SAME board — same zones, same exclusions, same fingerprint.
//
// The properties pinned here are the ones a field game depends on and a glance cannot check:
//   1. round trip   — export → parseZoneInput gives back the exact stored rings.
//   2. exclusions   — an excluded area comes back excluded, not added (the bug that made the
//                     bay playable on one phone and out of bounds on the other).
//   3. holes        — a polygon's inner ring imports as an exclusion instead of vanishing.
//   4. fingerprint  — equal across the round trip, order-independent (the board is), blind to
//                     names, and different for any real change of geometry or mode.
//   5. import order — adds fold before subtractions, whatever order the file lists them in.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf } from "./helpers/turf-env.mjs";
import { exportAreaGeoJSON, exportAreaText, areaFingerprint, addsBeforeSubtractions, AREA_KIND } from "../src/area-share.js";
import { parseZoneInput, assembleBoard } from "../src/geo.js";

const square = (lat, lng, half) => [
  [lat - half, lng - half], [lat - half, lng + half],
  [lat + half, lng + half], [lat + half, lng - half],
];
// Coordinates as a tap produces them: full double precision, nowhere near 6 decimals.
const jitter = (ring) => ring.map(([a, b], i) => [a + 1.234567891e-7 * (i + 1), b - 9.87654321e-8 * (i + 1)]);

const BOARD = jitter(square(19.076, 72.8777, 0.1));
const BAY = jitter(square(19.076, 72.8777, 0.03));
const game = {
  name: "Mumbai run",
  zones: [
    { id: "z1", name: "Main board", polygon: BOARD },
    { id: "z2", name: "The bay", polygon: BAY, mode: "subtract" },
  ],
};
const km2 = (g) => (g ? turf.area(turf.feature(g)) / 1e6 : 0);

test("export is a valid FeatureCollection the import box already reads", () => {
  const fc = exportAreaGeoJSON(game);
  assert.equal(fc.type, "FeatureCollection");
  assert.equal(fc.features.length, 2);
  for (const f of fc.features) {
    assert.equal(f.type, "Feature");
    assert.equal(f.geometry.type, "Polygon");
    const ring = f.geometry.coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1], "GeoJSON rings must be closed");
    // [lng, lat] order: longitudes here are ~72.8, latitudes ~19.
    assert.ok(ring[0][0] > 70 && ring[0][1] < 20, `axis order wrong: ${ring[0]}`);
  }
  assert.equal(fc.jltg.kind, AREA_KIND);
  assert.equal(fc.jltg.fingerprint, areaFingerprint(game.zones));
  // Parses as JSON, i.e. pasteable.
  assert.deepEqual(JSON.parse(exportAreaText(game)), fc);
});

test("round trip: the import gives back the same rings, names and exclusion", () => {
  const parsed = parseZoneInput(exportAreaText(game));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "Main board");
  assert.equal(parsed[0].mode, undefined, "an added zone must not come back tagged");
  assert.equal(parsed[1].name, "The bay");
  assert.equal(parsed[1].mode, "subtract", "an excluded area must come back excluded");
  // Open rings, same vertex count, each vertex within 1e-6° (the export precision).
  for (const [i, src] of [BOARD, BAY].entries()) {
    assert.equal(parsed[i].ring.length, src.length);
    parsed[i].ring.forEach(([lat, lng], v) => {
      assert.ok(Math.abs(lat - src[v][0]) < 1e-6 && Math.abs(lng - src[v][1]) < 1e-6, `vertex ${v} drifted`);
    });
  }
});

test("round trip: the fingerprint survives export → import exactly", () => {
  const parsed = parseZoneInput(exportAreaText(game));
  const received = parsed.map((p, i) => ({ id: `r${i}`, name: p.name, polygon: p.ring, ...(p.mode ? { mode: p.mode } : {}) }));
  assert.equal(areaFingerprint(received), areaFingerprint(game.zones));
  // ...and exporting the RECEIVED board gives byte-identical text apart from the name.
  const again = exportAreaGeoJSON({ name: game.name, zones: received });
  assert.deepEqual(again.features, exportAreaGeoJSON(game).features);
});

test("the received board has the hole: same area as the sender's", () => {
  const parsed = parseZoneInput(exportAreaText(game));
  const received = parsed.map((p) => ({ polygon: p.ring, ...(p.mode ? { mode: p.mode } : {}) }));
  const a = km2(assembleBoard(game.zones));
  const b = km2(assembleBoard(received));
  assert.ok(a > 0 && Math.abs(a - b) < 0.01, `sender ${a.toFixed(3)} km² vs receiver ${b.toFixed(3)} km²`);
  // And the hole is real, not ignored: smaller than the outer square alone.
  assert.ok(b < km2(assembleBoard([{ polygon: BOARD }])) - 30); // the bay is ~42 km²
});

test("fingerprint is order-independent and blind to names", () => {
  const swapped = [game.zones[1], game.zones[0]];
  assert.equal(areaFingerprint(swapped), areaFingerprint(game.zones));
  const renamed = game.zones.map((z) => ({ ...z, name: "Imported zone" }));
  assert.equal(areaFingerprint(renamed), areaFingerprint(game.zones));
});

test("fingerprint changes when the board really changes", () => {
  const base = areaFingerprint(game.zones);
  // The bay made an ADDED zone instead of excluded — the exact bug this export guards against.
  const modeLost = game.zones.map((z) => ({ ...z, mode: undefined }));
  assert.notEqual(areaFingerprint(modeLost), base);
  // One vertex moved by ~1 m.
  const moved = game.zones.map((z, i) => (i === 0 ? { ...z, polygon: z.polygon.map((p, v) => (v === 0 ? [p[0] + 0.00001, p[1]] : p)) } : z));
  assert.notEqual(areaFingerprint(moved), base);
  // A zone dropped.
  assert.notEqual(areaFingerprint([game.zones[0]]), base);
});

test("fingerprint ignores a closing vertex and sub-precision noise", () => {
  const closed = game.zones.map((z) => ({ ...z, polygon: [...z.polygon, [...z.polygon[0]]] }));
  assert.equal(areaFingerprint(closed), areaFingerprint(game.zones));
  const noisy = game.zones.map((z) => ({ ...z, polygon: z.polygon.map(([a, b]) => [a + 1e-9, b - 1e-9]) }));
  assert.equal(areaFingerprint(noisy), areaFingerprint(game.zones));
});

test("an empty board has no fingerprint and exports no features", () => {
  assert.equal(areaFingerprint([]), "");
  assert.equal(areaFingerprint(undefined), "");
  assert.deepEqual(exportAreaGeoJSON({ zones: [] }).features, []);
  // Degenerate rings are skipped exactly as the fold skips them.
  assert.equal(exportAreaGeoJSON({ zones: [{ polygon: [[1, 2], [3, 4]] }] }).features.length, 0);
});

test("a pasted polygon's inner ring imports as an exclusion, not a vanished hole", () => {
  const outer = square(19.076, 72.8777, 0.1).map(([lat, lng]) => [lng, lat]);
  const inner = square(19.076, 72.8777, 0.03).map(([lat, lng]) => [lng, lat]);
  outer.push([...outer[0]]); inner.push([...inner[0]]);
  const parsed = parseZoneInput(JSON.stringify({ type: "Feature", properties: { name: "City" }, geometry: { type: "Polygon", coordinates: [outer, inner] } }));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].mode, undefined);
  assert.equal(parsed[1].mode, "subtract");
  assert.equal(parsed[1].name, "City (hole)");
  const area = km2(assembleBoard(parsed.map((p) => ({ polygon: p.ring, mode: p.mode }))));
  assert.ok(area < km2(assembleBoard([{ polygon: parsed[0].ring }])) - 30, "the hole must cut the board");
});

test("plain GeoJSON and coordinate lists still import as before", () => {
  const poly = { type: "Polygon", coordinates: [[[72.82, 19.09], [72.84, 19.09], [72.84, 19.11], [72.82, 19.11], [72.82, 19.09]]] };
  const p1 = parseZoneInput(JSON.stringify(poly));
  assert.equal(p1.length, 1);
  assert.deepEqual(p1[0].ring[0], [19.09, 72.82]);
  assert.equal(p1[0].ring.length, 4);
  const p2 = parseZoneInput("19.09,72.82\n19.09,72.84\n19.11,72.84");
  assert.equal(p2.length, 1);
  assert.equal(p2[0].mode, undefined);
});

test("import order: adds fold before subtractions, whatever the file says", () => {
  const ordered = addsBeforeSubtractions([
    { name: "bay", mode: "subtract" }, { name: "a" }, { name: "hole", mode: "subtract" }, { name: "b" },
  ]);
  assert.deepEqual(ordered.map((z) => z.name), ["a", "b", "bay", "hole"]);
  // A file listing the bay FIRST still yields the holed board when folded one zone at a time,
  // which is how Zones.importText adds them.
  const parsed = parseZoneInput(JSON.stringify({ type: "FeatureCollection", features: [...exportAreaGeoJSON(game).features].reverse() }));
  assert.equal(parsed[0].mode, "subtract", "precondition: the file lists the exclusion first");
  const folded = [];
  let last = null;
  for (const z of addsBeforeSubtractions(parsed)) {
    folded.push({ polygon: z.ring, mode: z.mode });
    last = assembleBoard(folded);
    assert.ok(last, `fold refused at ${z.name}`);
  }
  assert.ok(Math.abs(km2(last) - km2(assembleBoard(game.zones))) < 0.01);
});
