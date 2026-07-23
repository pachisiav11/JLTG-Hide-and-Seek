// "Add stations (tap map)": replaces the old nearest-station snap (which broke
// exactly when OSM/Places hadn't surfaced the real station) with a plain pin drop.
// This suite covers makeManualStation() — the pure factory behind each tap.
import test from "node:test";
import assert from "node:assert/strict";
import { makeManualStation } from "../src/stations.js";

test("manual 1: builds a station at the exact tapped point, no snapping", () => {
  const st = makeManualStation({ lat: 19.076, lng: 72.8777 }, 1);
  assert.equal(st.lat, 19.076);
  assert.equal(st.lng, 72.8777);
  assert.equal(st.kind, "manual");
});

test("manual 2: names it generically from the sequence number — no name prompt needed", () => {
  const a = makeManualStation({ lat: 19.1, lng: 72.9 }, 1);
  const b = makeManualStation({ lat: 19.2, lng: 72.8 }, 7);
  assert.equal(a.name, "Station 1");
  assert.equal(b.name, "Station 7");
});

test("manual 3: two pins get distinct ids even with the same sequence number", () => {
  const a = makeManualStation({ lat: 19.1, lng: 72.9 }, 1);
  const b = makeManualStation({ lat: 19.1, lng: 72.9 }, 1);
  assert.notEqual(a.id, b.id);
});

test("manual 4: refuses a non-finite point rather than adding a broken station", () => {
  assert.equal(makeManualStation({ lat: NaN, lng: 72.9 }, 1), null);
  assert.equal(makeManualStation({ lat: 19.1, lng: undefined }, 1), null);
  assert.equal(makeManualStation(null, 1), null);
});
