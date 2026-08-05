// stationsOnLineWithLabels — which stations sit on the chosen line, and what else they serve.
//
// This is what Station's Line rests on now that the persistent station set is gone: the card
// sources stations per question and this decides which of them the answer is about. Get it
// wrong in one direction and the "same line" answer keeps ground the hider cannot be on; get
// it wrong in the other and it eliminates ground they can. Neither is visible on the map.
//
// It is pure precisely so these rules can be checked without a browser, a network or OSM.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stationsOnLineWithLabels } from "../src/stations.js";

// Two north-south lines ~7 km apart at this latitude, and stations placed ON each.
const WESTERN = { id: "w", label: "Western Line", paths: [[[19.00, 72.85], [19.14, 72.85]]] };
const CENTRAL = { id: "c", label: "Central Line", paths: [[[19.00, 72.92], [19.14, 72.92]]] };
const ALL = [WESTERN, CENTRAL];

const STATIONS = [
  { id: "1", name: "Andheri", lat: 19.02, lng: 72.85 },   // Western
  { id: "2", name: "Bandra", lat: 19.06, lng: 72.85 },    // Western
  { id: "3", name: "Dadar W", lat: 19.10, lng: 72.85 },   // Western
  { id: "4", name: "Dadar C", lat: 19.10, lng: 72.92 },   // Central
  { id: "5", name: "Kurla", lat: 19.04, lng: 72.92 },     // Central
  { id: "6", name: "Faraway", lat: 19.15, lng: 72.97 },   // neither
];

const names = (out) => out.map((s) => s.name).sort();

test("returns exactly the stations on the chosen line", () => {
  assert.deepEqual(names(stationsOnLineWithLabels(STATIONS, WESTERN, ALL)), ["Andheri", "Bandra", "Dadar W"]);
  assert.deepEqual(names(stationsOnLineWithLabels(STATIONS, CENTRAL, ALL)), ["Dadar C", "Kurla"]);
});

test("a station on no line is never returned", () => {
  const all = [...stationsOnLineWithLabels(STATIONS, WESTERN, ALL), ...stationsOnLineWithLabels(STATIONS, CENTRAL, ALL)];
  assert.ok(!all.some((s) => s.name === "Faraway"),
    "a station off every line must not be offered for any of them");
});

test("each station carries the lines it serves", () => {
  const out = stationsOnLineWithLabels(STATIONS, WESTERN, ALL);
  assert.deepEqual(out.find((s) => s.name === "Andheri").lines, ["Western Line"]);
});

test("an interchange names both lines — the case the confirm step exists for", () => {
  // A single node sitting on both ways. This is the station a seeker second-guesses, so the
  // list must say so rather than showing a bare name identical to a single-line stop.
  // Placed on the crossing itself: `paths` are [lat, lng], so `wide` runs along lng 72.88 and
  // `also` along lat 19.10, and they meet at exactly this point.
  const interchange = { id: "x", name: "Dadar", lat: 19.10, lng: 72.88 };
  const wide = { id: "w", label: "Western Line", paths: [[[19.00, 72.88], [19.14, 72.88]]] };
  const also = { id: "c", label: "Central Line", paths: [[[19.10, 72.86], [19.10, 72.91]]] };
  const out = stationsOnLineWithLabels([interchange], wide, [wide, also]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].lines.sort(), ["Central Line", "Western Line"]);
});

test("coordinates and ids survive the round trip", () => {
  // The caller commits these straight onto the step, where the geometry buffers them.
  const out = stationsOnLineWithLabels(STATIONS, WESTERN, ALL);
  const a = out.find((s) => s.id === "1");
  assert.equal(a.lat, 19.02);
  assert.equal(a.lng, 72.85);
  assert.equal(a.name, "Andheri");
});

test("with no other lines supplied, stations still report the one they are on", () => {
  // The card always passes the full candidate list, but a caller that does not must still
  // get a usable shape rather than an empty `lines` array that renders as "— only".
  const out = stationsOnLineWithLabels(STATIONS, WESTERN);
  assert.ok(out.length > 0);
  for (const s of out) assert.deepEqual(s.lines, ["Western Line"]);
});

test("a duplicate line label is not repeated on a station", () => {
  // Two OSM ways for the same service (a trunk shared by S3/S5, or a line split at a
  // junction) both match. The label must appear once, or the row reads "also Western Line,
  // Western Line".
  const twice = [
    { id: "w1", label: "Western Line", paths: [[[19.00, 72.85], [19.08, 72.85]]] },
    { id: "w2", label: "Western Line", paths: [[[19.06, 72.85], [19.14, 72.85]]] },
  ];
  const out = stationsOnLineWithLabels(STATIONS, twice[0], twice);
  for (const s of out) {
    assert.equal(new Set(s.lines).size, s.lines.length, `${s.name} repeats a label: ${s.lines}`);
  }
});

test("the tolerance is honoured, so a near-miss can be excluded deliberately", () => {
  // ~550 m east of the Western way. In by default (100 m tolerance is generous in degrees
  // here? no — assert both directions explicitly rather than assuming).
  const nearMiss = [{ id: "n", name: "Near", lat: 19.06, lng: 72.855 }];
  const tight = stationsOnLineWithLabels(nearMiss, WESTERN, ALL, { toleranceM: 50 });
  const loose = stationsOnLineWithLabels(nearMiss, WESTERN, ALL, { toleranceM: 2000 });
  assert.equal(tight.length, 0, "a 50 m tolerance must exclude a station ~500 m off the way");
  assert.equal(loose.length, 1, "a 2 km tolerance must include it");
});

test("empty and malformed input yields an empty list rather than throwing", () => {
  // Sourcing can legitimately come back with nothing (no proxy, a board with no rail), and
  // the card refuses on an empty list. It must not have to catch for that.
  assert.deepEqual(stationsOnLineWithLabels([], WESTERN, ALL), []);
  assert.deepEqual(stationsOnLineWithLabels(STATIONS, { label: "Nowhere", paths: [] }, ALL), []);
  assert.deepEqual(stationsOnLineWithLabels(null, WESTERN, ALL), []);
  assert.deepEqual(stationsOnLineWithLabels(STATIONS, null, ALL), []);
  assert.deepEqual(stationsOnLineWithLabels(STATIONS, WESTERN, null).length, 3);
});
