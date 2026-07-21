// Phase 36 (req #7a): the shared, ref-counted geolocation watch.
//
// One OS watchPosition fanned out to N subscribers, opened on the first
// subscribe and cleared on the last unsubscribe — so the geofence, the seeker,
// and the self-dot cost ONE GPS subscription between them, not three.
import test from "node:test";
import assert from "node:assert/strict";
import { GeoWatch } from "../src/geo-watch.js";

function mockGeo() {
  const calls = { watchPosition: 0, clearWatch: [] };
  let handler = null, errHandler = null, nextId = 100;
  return {
    calls,
    fire(lat, lng, accuracy) { handler?.({ coords: { latitude: lat, longitude: lng, accuracy }, timestamp: 123 }); },
    fireErr(e) { errHandler?.(e); },
    watchPosition(onPos, onErr) { calls.watchPosition++; handler = onPos; errHandler = onErr; return nextId++; },
    clearWatch(id) { calls.clearWatch.push(id); handler = null; },
  };
}

test("watch 1: one OS watch is opened for N subscribers, fanning each fix to all", () => {
  const geo = mockGeo();
  const w = new GeoWatch({ geolocation: geo });
  const a = [], b = [];
  w.subscribe((f) => a.push(f));
  w.subscribe((f) => b.push(f));
  assert.equal(geo.calls.watchPosition, 1, "only ONE OS watch for two subscribers");
  assert.equal(w.subscriberCount, 2);

  geo.fire(19.1, 72.9, 12);
  assert.equal(a.length, 1);
  assert.deepEqual(b[0], { lat: 19.1, lng: 72.9, accuracy: 12, at: 123 }, "the fix is normalised and fanned to every subscriber");
});

test("watch 2: the OS watch is cleared only on the LAST unsubscribe", () => {
  const geo = mockGeo();
  const w = new GeoWatch({ geolocation: geo });
  const off1 = w.subscribe(() => {});
  const off2 = w.subscribe(() => {});
  const firstId = geo.calls.clearWatch.length; // 0
  off1();
  assert.equal(geo.calls.clearWatch.length, firstId, "still one subscriber → keep the OS watch");
  assert.equal(w.active, true);
  off2();
  assert.equal(w.active, false, "last unsubscribe stops the OS watch");
  assert.equal(geo.calls.clearWatch.length, 1, "clearWatch called exactly once");
});

test("watch 3: a fresh subscription after a full teardown re-opens the OS watch", () => {
  const geo = mockGeo();
  const w = new GeoWatch({ geolocation: geo });
  const off = w.subscribe(() => {});
  off();
  assert.equal(w.active, false);
  w.subscribe(() => {});
  assert.equal(geo.calls.watchPosition, 2, "re-subscribed → a second OS watch opens");
});

test("watch 4: replayLast delivers the cached fix on subscribe; default does not", () => {
  const geo = mockGeo();
  const w = new GeoWatch({ geolocation: geo });
  w.subscribe(() => {});      // opens the watch
  geo.fire(19.2, 72.8, 8);    // caches a fix
  assert.deepEqual(w.lastFix, { lat: 19.2, lng: 72.8, accuracy: 8, at: 123 });

  const late = [];
  w.subscribe((f) => late.push(f), null, { replayLast: true });
  assert.equal(late.length, 1, "a replayLast subscriber draws immediately from cache");

  const noReplay = [];
  w.subscribe((f) => noReplay.push(f)); // default: transition consumers see only NEW fixes
  assert.equal(noReplay.length, 0);
});

test("watch 5: a throwing subscriber does not break the others", () => {
  const geo = mockGeo();
  const w = new GeoWatch({ geolocation: geo });
  const seen = [];
  w.subscribe(() => { throw new Error("boom"); });
  w.subscribe((f) => seen.push(f));
  assert.doesNotThrow(() => geo.fire(1, 2, 3));
  assert.equal(seen.length, 1, "the healthy subscriber still got the fix");
});

test("watch 6: errors fan out to onError handlers", () => {
  const geo = mockGeo();
  const w = new GeoWatch({ geolocation: geo });
  const errs = [];
  w.subscribe(() => {}, (e) => errs.push(e.message));
  geo.fireErr(new Error("permission denied"));
  assert.deepEqual(errs, ["permission denied"]);
});

test("watch 7: no geolocation → subscribe is a safe no-op", () => {
  const w = new GeoWatch({ geolocation: null });
  assert.doesNotThrow(() => { const off = w.subscribe(() => {}); off(); });
  assert.equal(w.active, false);
});
