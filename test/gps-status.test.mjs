// Phase 35 (req #5): the shared "Location on" chip appears whenever any GPS
// watch is active and disappears when they all stop.
import test from "node:test";
import assert from "node:assert/strict";
import { GeoWatch } from "../src/geo-watch.js";

// Minimal fake DOM so the shared pill-stack (createPill) can mount headless.
function makeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: tag, id: "", className: "", _text: "", children: [],
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: () => {} },
    get textContent() { return el._text; }, set textContent(v) { el._text = v; },
    setAttribute: () => {},
    appendChild: (c) => { el.children.push(c); c.parent = el; return c; },
    remove: () => { const p = el.parent; if (p) p.children = p.children.filter((x) => x !== el); },
  };
  Object.defineProperty(el, "onclick", { value: null, writable: true });
  return el;
}
function walk(n, fn) { fn(n); for (const c of n.children || []) walk(c, fn); }

const body = makeEl("body");
globalThis.document = {
  body,
  createElement: (t) => makeEl(t),
  getElementById: (id) => { let h = null; walk(body, (n) => { if (n.id === id) h = n; }); return h; },
};

const { GpsStatus } = await import("../src/gps-status.js");

function mockGeo() {
  let handler = null, id = 1;
  return {
    watchPosition(onPos) { handler = onPos; return id++; },
    clearWatch() { handler = null; },
  };
}
const hasChip = () => !!document.getElementById("gps-status-pill");

test("gps 1: the chip appears when a watch activates and reads 'Location on'", () => {
  const watch = new GeoWatch({ geolocation: mockGeo() });
  const status = new GpsStatus({ watch });
  status.init();
  assert.equal(hasChip(), false, "no chip while nothing is watching");

  const off = watch.subscribe(() => {}); // some feature starts a watch
  assert.equal(hasChip(), true, "chip shows once location is in use");
  const chip = document.getElementById("gps-status-pill");
  const textSpan = chip.children.find((c) => c.className === "pill-text");
  assert.match(textSpan.textContent, /location on/i);

  off();
  status.destroy();
});

test("gps 2: the chip disappears only when the LAST watcher stops", () => {
  const watch = new GeoWatch({ geolocation: mockGeo() });
  const status = new GpsStatus({ watch });
  status.init();
  const offA = watch.subscribe(() => {}); // e.g. self-dot
  const offB = watch.subscribe(() => {}); // e.g. geofence
  assert.equal(hasChip(), true);

  offA();
  assert.equal(hasChip(), true, "one watcher left → location still in use → chip stays");
  offB();
  assert.equal(hasChip(), false, "all watchers gone → chip hides");
  status.destroy();
});

test("gps 3: a status observer starts in sync — mounting while already active shows the chip", () => {
  const watch = new GeoWatch({ geolocation: mockGeo() });
  const off = watch.subscribe(() => {}); // watch already running before the chip mounts
  const status = new GpsStatus({ watch });
  status.init();
  assert.equal(hasChip(), true, "onActiveChange fires immediately with the current (active) state");
  off();
  assert.equal(hasChip(), false);
  status.destroy();
});
