// Phase 31 (req #1): tap-the-map-to-select-nearest-station.
//
// The station dots are tiny; hitting one on a phone is fiddly. "Select on map"
// arms a one-shot map pick, snaps the tap to the CLOSEST station, and opens the
// Phase 30 chooser for it. This suite covers:
//   - nearestStation() — the pure snap (closest wins, non-finite skipped, nulls)
//   - openChooserForStation() end-to-end opens a 2-option menu for that station
import test from "node:test";
import assert from "node:assert/strict";
import { nearestStation } from "../src/stations.js";

const STATIONS = () => [
  { id: "osm:node/1", name: "Devipada", lat: 19.24, lng: 72.87 },
  { id: "osm:node/2", name: "Dahisar", lat: 19.25, lng: 72.86 },
  { id: "osm:node/3", name: "Andheri", lat: 19.12, lng: 72.85 },
];

test("nearest 1: picks the closest station to the tap", () => {
  const list = STATIONS();
  // A tap just south of Andheri (19.12) must snap to Andheri, not the northern pair.
  const hit = nearestStation(list, { lat: 19.125, lng: 72.851 });
  assert.equal(hit.id, "osm:node/3");
  // A tap between Devipada and Dahisar, nearer Dahisar.
  const hit2 = nearestStation(list, { lat: 19.249, lng: 72.861 });
  assert.equal(hit2.id, "osm:node/2");
});

test("nearest 2: stations with non-finite coords are skipped, not NaN-sorted to the front", () => {
  const list = [
    { id: "bad", name: "Broken", lat: NaN, lng: 72.87 },
    { id: "good", name: "Real", lat: 19.24, lng: 72.87 },
  ];
  const hit = nearestStation(list, { lat: 19.2, lng: 72.87 });
  assert.equal(hit.id, "good", "a NaN-coord station must never win the nearest slot");
});

test("nearest 3: empty list, missing point, and garbage all return null (no throw)", () => {
  assert.equal(nearestStation([], { lat: 19, lng: 72 }), null);
  assert.equal(nearestStation(null, { lat: 19, lng: 72 }), null);
  assert.equal(nearestStation(STATIONS(), null), null);
  assert.equal(nearestStation(STATIONS(), { lat: NaN, lng: 72 }), null);
});

test("nearest 4: exact hit on a station returns that station (distance 0)", () => {
  const list = STATIONS();
  const hit = nearestStation(list, { lat: 19.12, lng: 72.85 });
  assert.equal(hit.id, "osm:node/3");
});

// --- End-to-end: the snapped station opens its Phase 30 chooser ---

function makeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: tag, id: "", className: "", _text: "", style: {}, children: [],
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: () => {} },
    get textContent() { return el._text; },
    set textContent(v) { el._text = v; },
    appendChild: (c) => { el.children.push(c); c.parent = el; return c; },
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    remove: () => { const p = el.parent; if (p) p.children = p.children.filter((x) => x !== c); },
    contains: () => false,
    getBoundingClientRect: () => ({ width: 120, height: 44, left: 0, top: 0 }),
  };
  return el;
}
function walk(n, fn) { fn(n); for (const c of n.children || []) walk(c, fn); }

test("select 1: openChooserForStation opens a 2-option menu for the snapped station", async () => {
  const body = makeEl("body");
  const doc = {
    body,
    createElement: (t) => makeEl(t),
    getElementById: (id) => { let h = null; walk(body, (n) => { if (n.id === id) h = n; }); return h; },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.document = doc;
  globalThis.window = Object.assign(globalThis.window || {}, { innerWidth: 800, innerHeight: 600, google: { maps: { Marker: class {}, SymbolPath: { CIRCLE: 0 } } } });
  globalThis.google = globalThis.window.google;

  const { StationsLayer } = await import("../src/stations-layer.js");
  const layer = new StationsLayer({ addListener: () => ({ remove() {} }) });

  const list = STATIONS();
  const tapped = nearestStation(list, { lat: 19.125, lng: 72.851 }); // → Andheri
  assert.equal(tapped.id, "osm:node/3");

  layer.openChooserForStation(tapped);

  const menu = doc.getElementById("ctx-menu");
  assert.ok(menu, "a context menu was opened for the snapped station");
  const labels = menu.children.map((b) => b.textContent);
  assert.equal(labels.length, 2, "the Phase 30 chooser offers exactly two actions");
  assert.match(labels[0], /note/i);
  assert.match(labels[1], /eliminate/i, "Andheri is active → toggle reads 'Eliminate'");
});
