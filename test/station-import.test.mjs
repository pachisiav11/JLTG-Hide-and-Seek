// v2 Phase 3, item O — import a station list from CSV, GeoJSON or KML.
//
// The point is not the file formats. It is that a group who have already agreed a station
// set — a shared Google MyMaps layer, a spreadsheet of "stops we're playing", a converted
// GTFS export — currently have to retype it or play with a different set from the one they
// agreed. KML is here because MyMaps exports it and MyMaps is what non-technical players use.
//
// The tests lean on the failure modes rather than the happy path, because the happy path is
// the part that was never going to break: swapped lat/lng columns, quoted fields with commas,
// CRLF from a spreadsheet, CDATA-wrapped names from MyMaps, and re-importing the same file
// twice over a set the seeker has already eliminated stations in.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStations, parseStationsCsv, parseStationsGeoJson, parseStationsKml, mergeStations,
} from "../src/station-import.js";

// ---- CSV ----------------------------------------------------------------

test("CSV: the ordinary spreadsheet export", () => {
  const csv = "name,lat,lng\nChurchgate,18.9354,72.8271\nDadar,19.0186,72.8443\n";
  const out = parseStationsCsv(csv);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "Churchgate");
  assert.ok(Math.abs(out[0].lat - 18.9354) < 1e-9);
  assert.ok(Math.abs(out[0].lng - 72.8271) < 1e-9);
  assert.equal(out[0].kind, "custom");
});

test("CSV: alternative column spellings, including GTFS", () => {
  for (const header of ["latitude,longitude,title", "y,x,station", "stop_lat,stop_lon,stop_name"]) {
    const out = parseStationsCsv(`${header}\n19.0,72.8,Test\n`);
    assert.equal(out.length, 1, header);
    assert.equal(out[0].name, "Test", header);
  }
});

test("CSV: quoted fields with embedded commas survive", () => {
  const csv = 'name,lat,lng\n"Dadar, Central",19.0186,72.8443\n';
  const out = parseStationsCsv(csv);
  assert.equal(out[0].name, "Dadar, Central");
});

test("CSV: doubled quotes are unescaped", () => {
  const csv = 'name,lat,lng\n"The ""Old"" Station",19.0,72.8\n';
  assert.equal(parseStationsCsv(csv)[0].name, 'The "Old" Station');
});

test("CSV: CRLF line endings and a UTF-8 BOM", () => {
  const csv = "﻿name,lat,lng\r\nA,19.0,72.8\r\nB,19.1,72.9\r\n";
  assert.equal(parseStationsCsv(csv).length, 2);
});

test("CSV: a missing coordinate column names the spellings it accepts", () => {
  // "Invalid CSV" is useless here — the fix is renaming one column and the player cannot
  // guess which spellings are understood.
  assert.throws(() => parseStationsCsv("name,x\nA,1\n"), /No latitude column.*latitude/s);
  assert.throws(() => parseStationsCsv("name,lat\nA,1\n"), /No longitude column.*longitude/s);
});

test("CSV: one unparseable row is skipped, the rest of the file imports", () => {
  const csv = "name,lat,lng\nGood,19.0,72.8\nBad,not-a-number,72.9\nAlsoGood,19.2,73.0\n";
  const out = parseStationsCsv(csv);
  assert.deepEqual(out.map((s) => s.name), ["Good", "AlsoGood"]);
});

test("CSV: impossible coordinates are rejected rather than placed off the map", () => {
  // Out of range in either axis is unambiguously wrong and must not become a zone.
  assert.equal(parseStationsCsv("name,lat,lng\nBadLat,91.5,72.8\n").length, 0);
  assert.equal(parseStationsCsv("name,lat,lng\nBadLng,19.0,181.2\n").length, 0);
  assert.equal(parseStationsCsv("name,lat,lng\nBoth,-90.1,-180.1\n").length, 0);
});

// Worth stating explicitly, because the obvious test to write here is wrong. Mumbai's
// 18.9354,72.8271 swaps to 72.8271,18.9354 — and 72.8271 IS a valid latitude (northern
// Siberia), so range checking cannot catch it. Nothing in the file distinguishes a genuine
// Siberian board from a transposed Indian one.
//
// Guessing would be worse than not guessing: a heuristic that rejects "implausible"
// latitudes would break every real high-latitude board, which is exactly where Jet Lag is
// often played. The right place to catch this is the map — the imported stations land
// visibly nowhere near the board — so the importer's job is to be predictable, not clever.
test("CSV: an in-range transposition is imported as given, by design", () => {
  const out = parseStationsCsv("name,lat,lng\nSwapped,72.8271,18.9354\n");
  assert.equal(out.length, 1, "72.8 is a real latitude; rejecting it would break Arctic boards");
  assert.ok(Math.abs(out[0].lat - 72.8271) < 1e-9, "and it is imported exactly as written");
});

test("CSV: unnamed rows still get a usable label", () => {
  const out = parseStationsCsv("lat,lng\n19.0,72.8\n19.1,72.9\n");
  assert.equal(out.length, 2);
  assert.ok(out[0].name && out[1].name, "every station needs something to show in the list");
  assert.notEqual(out[0].name, out[1].name, "and the labels must be distinguishable");
});

// ---- GeoJSON ------------------------------------------------------------

test("GeoJSON: a FeatureCollection of points, in [lng, lat] order", () => {
  const gj = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [72.8271, 18.9354] }, properties: { name: "Churchgate" } },
      { type: "Feature", geometry: { type: "Point", coordinates: [72.8443, 19.0186] }, properties: { "name:en": "Dadar" } },
    ],
  };
  const out = parseStationsGeoJson(gj);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "Churchgate");
  assert.ok(Math.abs(out[0].lat - 18.9354) < 1e-9, "GeoJSON axis order must not be transposed");
  assert.equal(out[1].name, "Dadar", "name:en is preferred where present");
});

test("GeoJSON: non-point geometries are ignored, not approximated", () => {
  // A drawn route's first vertex is not a station; inventing one puts a phantom zone on the
  // board that nobody can account for.
  const gj = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "LineString", coordinates: [[72.8, 19.0], [72.9, 19.1]] }, properties: { name: "Route" } },
      { type: "Feature", geometry: { type: "Polygon", coordinates: [[[72.8, 19.0], [72.9, 19.0], [72.9, 19.1], [72.8, 19.0]]] }, properties: { name: "Zone" } },
      { type: "Feature", geometry: { type: "Point", coordinates: [72.85, 19.05] }, properties: { name: "Real" } },
    ],
  };
  const out = parseStationsGeoJson(gj);
  assert.deepEqual(out.map((s) => s.name), ["Real"]);
});

test("GeoJSON: a MultiPoint becomes one station per entrance", () => {
  const gj = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "MultiPoint", coordinates: [[72.80, 19.00], [72.81, 19.01]] },
      properties: { name: "Two entrances" },
    }],
  };
  const out = parseStationsGeoJson(gj);
  assert.equal(out.length, 2, "each entrance is separate ground the hider could be at");
  assert.notEqual(out[0].id, out[1].id, "and must not collapse to one id");
});

test("GeoJSON: accepts a raw string as well as an object", () => {
  const out = parseStationsGeoJson('{"type":"Point","coordinates":[72.8,19.0]}');
  assert.equal(out.length, 1);
});

// ---- KML ----------------------------------------------------------------

const MYMAPS = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>My stations</name>
  <Placemark><name><![CDATA[Churchgate]]></name>
    <Point><coordinates>72.8271,18.9354,0</coordinates></Point></Placemark>
  <Placemark><name>Dadar &amp; Central</name>
    <Point><coordinates>72.8443,19.0186,0</coordinates></Point></Placemark>
  <Placemark><name>A drawn route</name>
    <LineString><coordinates>72.8,19.0 72.9,19.1</coordinates></LineString></Placemark>
</Document></kml>`;

test("KML: a Google MyMaps export, CDATA names and all", () => {
  const out = parseStationsKml(MYMAPS);
  assert.equal(out.length, 2, "the LineString placemark must not become a station");
  assert.equal(out[0].name, "Churchgate", "CDATA wrappers must be stripped");
  assert.equal(out[1].name, "Dadar & Central", "entities must be decoded");
  assert.ok(Math.abs(out[0].lat - 18.9354) < 1e-9, "KML is lng,lat,alt — altitude must not be read as latitude");
});

test("KML: an unnamed placemark still imports", () => {
  const kml = `<kml><Placemark><Point><coordinates>72.8,19.0</coordinates></Point></Placemark></kml>`;
  const out = parseStationsKml(kml);
  assert.equal(out.length, 1);
  assert.ok(out[0].name);
});

// ---- Dispatch -----------------------------------------------------------

test("format is sniffed from the content, not trusted from the hint", () => {
  // All three are routinely served with the wrong type: MyMaps as octet-stream, GeoJSON
  // saved as .json, CSV as .txt.
  assert.equal(parseStations(MYMAPS, "application/octet-stream").length, 2);
  assert.equal(parseStations('{"type":"Point","coordinates":[72.8,19.0]}', "text/csv").length, 1);
  assert.equal(parseStations("lat,lng\n19,72.8\n", "").length, 1);
});

test("an empty file says so rather than importing nothing silently", () => {
  assert.throws(() => parseStations("   "), /empty/i);
});

// ---- Merge --------------------------------------------------------------

test("merge de-duplicates by id and by coordinate", () => {
  const existing = [{ id: "custom:a", name: "A", lat: 19.0, lng: 72.8 }];
  const incoming = [
    { id: "custom:a", name: "A again", lat: 19.0, lng: 72.8 }, // same id
    { id: "custom:other", name: "Same spot", lat: 19.0, lng: 72.8 }, // same place, new id
    { id: "custom:b", name: "B", lat: 19.1, lng: 72.9 }, // genuinely new
  ];
  const { list, added, skipped } = mergeStations(existing, incoming, "merge");
  assert.equal(added, 1);
  assert.equal(skipped, 2);
  assert.deepEqual(list.map((s) => s.name), ["A", "B"]);
});

// The one that actually matters in play. Re-importing the file must not resurrect stations
// the seeker has searched and ruled out.
test("merge never overwrites an existing station, so eliminations survive a re-import", () => {
  const existing = [{ id: "custom:a", name: "A", lat: 19.0, lng: 72.8, eliminated: true }];
  const incoming = [{ id: "custom:a", name: "A", lat: 19.0, lng: 72.8 }];
  const { list } = mergeStations(existing, incoming, "merge");
  assert.equal(list.length, 1);
  assert.equal(list[0].eliminated, true, "a re-import must not un-eliminate a searched station");
});

test("replace drops the old set entirely", () => {
  const existing = [{ id: "custom:a", name: "A", lat: 19.0, lng: 72.8, eliminated: true }];
  const incoming = [{ id: "custom:b", name: "B", lat: 19.1, lng: 72.9 }];
  const { list, added } = mergeStations(existing, incoming, "replace");
  assert.deepEqual(list.map((s) => s.name), ["B"]);
  assert.equal(added, 1);
});

test("ids are stable across re-parses of the same file, so eliminations stick", () => {
  const csv = "name,lat,lng\nA,19.0,72.8\n";
  assert.equal(parseStationsCsv(csv)[0].id, parseStationsCsv(csv)[0].id);
  // And an explicit id in the file is preferred over the coordinate fallback.
  const withId = parseStationsCsv("id,name,lat,lng\nSTN1,A,19.0,72.8\n")[0];
  assert.match(withId.id, /STN1/);
});
