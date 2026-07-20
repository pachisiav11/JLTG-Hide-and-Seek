// Shaping tests for the /overpass/stations response.
//
// The playtest ended at Devipada — a `railway=halt`, not a `railway=station` — so
// halts must survive. Same-name near-by nodes must collapse to one entry (OSM often
// tags a single station under several schemes at slightly different coordinates), and
// unnamed nodes must drop out (a station a player cannot name is not answerable).
import test from "node:test";
import assert from "node:assert/strict";
import { buildStationsQuery, normalizeStations, bboxIsValid } from "../overpass-stations.js";

test("buildStationsQuery covers station, halt, and PT-station", () => {
  const q = buildStationsQuery("19.0,72.8,19.3,72.9");
  assert.match(q, /railway"="station"/);
  assert.match(q, /railway"="halt"/);
  assert.match(q, /public_transport"="station"/);
  // Same bbox in every clause — a mismatch would return stations off the board.
  const hits = q.match(/\(19\.0,72\.8,19\.3,72\.9\)/g);
  assert.equal(hits?.length, 3, "each clause needs the same bbox");
});

test("normalizeStations keeps named halts and drops unnamed nodes", () => {
  const json = { elements: [
    { type: "node", id: 1, lat: 19.24, lon: 72.87, tags: { railway: "halt", name: "Devipada" } },
    { type: "node", id: 2, lat: 19.10, lon: 72.85, tags: { railway: "station" } }, // no name → dropped
    { type: "node", id: 3, lat: 19.00, lon: 72.80, tags: { railway: "station", name: "Andheri" } },
  ] };
  const out = normalizeStations(json);
  assert.equal(out.stations.length, 2);
  const names = out.stations.map((s) => s.name).sort();
  assert.deepEqual(names, ["Andheri", "Devipada"]);
});

test("stable ids: same OSM node id => same station id", () => {
  const one = normalizeStations({ elements: [{ type: "node", id: 42, lat: 19.0, lon: 72.8, tags: { railway: "station", name: "Foo" } }] });
  const two = normalizeStations({ elements: [{ type: "node", id: 42, lat: 19.0, lon: 72.8, tags: { railway: "station", name: "Foo" } }] });
  assert.equal(one.stations[0].id, two.stations[0].id);
  assert.equal(one.stations[0].id, "osm:node/42");
});

test("near-by same-name tags collapse to one entry — station beats halt beats pt-station", () => {
  // OSM often has one physical station tagged three ways, within 20-30 m of each other.
  // The final "Devipada" row should be exactly one entry, and it should carry the
  // `station` id (canonical tagging) — not the halt or PT-station id.
  const json = { elements: [
    { type: "node", id: 100, lat: 19.2400, lon: 72.8700, tags: { railway: "halt", name: "Devipada" } },
    { type: "node", id: 101, lat: 19.2401, lon: 72.8701, tags: { railway: "station", name: "Devipada" } },
    { type: "node", id: 102, lat: 19.2402, lon: 72.8702, tags: { public_transport: "station", name: "Devipada" } },
  ] };
  const out = normalizeStations(json);
  assert.equal(out.stations.length, 1, "three tags of one station must collapse to one row");
  assert.equal(out.stations[0].id, "osm:node/101", "the canonical `station` tag wins over halt/pt-station");
  assert.equal(out.stations[0].kind, "station");
});

test("same-name stations far apart stay separate — a real chain, not a duplicate", () => {
  // Two "St James" stations 5 km apart (like London's dual naming) are different
  // stations; the dedup must not merge them.
  const json = { elements: [
    { type: "node", id: 200, lat: 51.5100, lon: -0.1300, tags: { railway: "station", name: "St James" } },
    { type: "node", id: 201, lat: 51.5600, lon: -0.1300, tags: { railway: "station", name: "St James" } },
  ] };
  const out = normalizeStations(json);
  assert.equal(out.stations.length, 2);
});

test("counts report raw vs kept — a picker can say how much was folded", () => {
  const json = { elements: [
    { type: "node", id: 1, lat: 19.24, lon: 72.87, tags: { railway: "halt", name: "Devipada" } },
    { type: "node", id: 2, lat: 19.10, lon: 72.85, tags: { railway: "station" } }, // dropped: no name
  ] };
  const out = normalizeStations(json);
  assert.equal(out.counts.raw, 2);
  assert.equal(out.counts.kept, 1);
});

test("bboxIsValid rejects swapped corners", () => {
  assert.ok(bboxIsValid("19.0,72.8,19.3,72.9"));
  assert.ok(!bboxIsValid("19.3,72.8,19.0,72.9"), "S>N must be rejected — a swapped corner matches nothing");
  assert.ok(!bboxIsValid("nan,,,72.9"));
});
