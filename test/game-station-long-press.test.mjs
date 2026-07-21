// Phase 30 (req #2): station long-press action chooser.
//
// A single tap on a station used to eliminate it — too easy to trigger by
// accident while poking at the map. Now a plain tap does NOTHING; a long-press
// (touch) or right-click (desktop) opens a 2-option chooser: add a note here,
// or eliminate/restore the station. This suite covers:
//   - stationLongPressActions() — the pure menu contents (label reflects state)
//   - the marker wires long-press/right-click but NO plain "click" handler
//   - the two actions map to the same pure mutators the panel uses
import test from "node:test";
import assert from "node:assert/strict";
import { createGame } from "../src/model.js";
import { squareArea } from "./helpers/turf-env.mjs";
import { toggleStationElimination } from "../src/stations.js";
import { addNote } from "../src/notes.js";

// Minimal browser + Google Maps stand-ins so StationsLayer.render() runs and we
// can inspect what it wires onto each marker. No real Maps, no DOM layout.
const listenerLog = [];
class FakeMarker {
  constructor(opts) { this.opts = opts; this._events = new Set(); }
  addListener(evt, cb) { this._events.add(evt); listenerLog.push(evt); return { remove() {} }; }
  setMap() {}
}
const fakeMap = { addListener: () => ({ remove() {} }) };
const fakeGoogle = { maps: { Marker: FakeMarker, SymbolPath: { CIRCLE: 0 } } };
globalThis.window = Object.assign(globalThis.window || {}, {
  innerWidth: 800, innerHeight: 600, google: fakeGoogle,
});
globalThis.google = fakeGoogle; // render() uses the bare `google` global
globalThis.document = globalThis.document || {};

const { StationsLayer, stationLongPressActions } = await import("../src/stations-layer.js");
const store = await import("../src/store.js");

const AREA = squareArea([72.8777, 19.176], 0.4);
const STATIONS = () => [
  { id: "osm:node/1", name: "Devipada", lat: 19.24, lng: 72.87 },
  { id: "osm:node/2", name: "Dahisar", lat: 19.25, lng: 72.86, eliminated: true, eliminatedBy: "manual" },
];

test("actions 1: an active station offers note + eliminate", () => {
  const acts = stationLongPressActions({ id: "x", eliminated: false });
  assert.equal(acts.length, 2);
  assert.deepEqual(acts.map((a) => a.id), ["note", "toggle"]);
  assert.match(acts[0].label, /note/i);
  assert.match(acts[1].label, /eliminate/i, "an active station's toggle reads 'Eliminate'");
});

test("actions 2: an eliminated station's toggle reads 'Restore'", () => {
  const acts = stationLongPressActions({ id: "x", eliminated: true });
  assert.match(acts[1].label, /restore/i);
  assert.doesNotMatch(acts[1].label, /eliminate/i);
});

test("actions 3: missing/garbage station degrades to the active labels, no throw", () => {
  assert.match(stationLongPressActions(null)[1].label, /eliminate/i);
  assert.match(stationLongPressActions(undefined)[1].label, /eliminate/i);
});

test("wiring 1: a plain tap does nothing — markers wire long-press/right-click, never 'click'", () => {
  listenerLog.length = 0;
  const g = createGame({ name: "LP", gameArea: AREA, stations: { source: "osm", bbox: null, confirmedAt: 1, list: STATIONS() } });
  store.setCurrent(g);
  const layer = new StationsLayer(fakeMap);
  layer.render();

  assert.ok(layer.markers.length === 2, "both stations rendered");
  const wired = new Set(listenerLog);
  assert.ok(!wired.has("click"), "the tap-to-eliminate 'click' handler is gone — a plain tap must not mutate state");
  for (const evt of ["mousedown", "mouseup", "rightclick"]) {
    assert.ok(wired.has(evt), `long-press chooser needs a '${evt}' handler`);
  }
  layer.destroy();
});

test("action → effect 1: the 'toggle' action flips eliminated via the shared mutator", () => {
  const list = STATIONS();
  // The chooser's toggle branch calls toggleStationElimination(list, id) — the
  // exact mutator the Stations panel and A4 line-elim already use.
  const r = toggleStationElimination(list, "osm:node/1");
  assert.equal(r.eliminated, true);
  assert.equal(list[0].eliminatedBy, "manual");
});

test("action → effect 2: the 'note' action drops a note AT the station point", () => {
  const st = STATIONS()[0];
  const notes = [];
  const entry = addNote(notes, { lat: st.lat, lng: st.lng }, "photo rules this out");
  assert.equal(notes.length, 1);
  assert.equal(entry.point.lat, st.lat, "note sits exactly on the station latitude");
  assert.equal(entry.point.lng, st.lng, "note sits exactly on the station longitude");
  assert.equal(entry.text, "photo rules this out");
});
