// Phase 48 (req #2) game test: the hider-zone pill reads green while inside,
// red once outside — a plain colour signal instead of the old regex-sniffed
// "is this text alarming" guess (which also mis-coloured the comfortably-safe
// state as neutral gray, never green).
import test from "node:test";
import assert from "node:assert/strict";

function makeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: tag, id: "", _text: "", children: [], attrs: {}, className: "",
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    get textContent() { return el._text; },
    set textContent(v) { el._text = v; },
    setAttribute: (k, v) => { el.attrs[k] = v; },
    appendChild: (child) => { el.children.push(child); child.parent = el; return child; },
    remove: () => { const p = el.parent; if (p) p.children = p.children.filter((c) => c !== el); },
  };
  return el;
}
const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
function makeDoc() {
  const body = makeEl("body");
  return {
    ...noopEvents,
    visibilityState: "visible",
    body,
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => { let hit = null; walk(body, (n) => { if (n.id === id) hit = n; }); return hit; },
  };
}
function walk(node, fn) { fn(node); for (const c of node.children || []) walk(c, fn); }

globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = makeDoc();
Object.defineProperty(globalThis, "navigator", {
  value: { geolocation: { watchPosition: () => 11, clearWatch: () => {} } },
  configurable: true, writable: true,
});

const { createGame } = await import("../src/model.js");
const { Geofence } = await import("../src/geofence.js");
const store = await import("../src/store.js");

const ZONE = { point: { lat: 19.24, lng: 72.87 }, radius: 500 };
const at = (dLat, dLng) => ({ lat: ZONE.point.lat + dLat, lng: ZONE.point.lng + dLng });

function boot(threshold = 100) {
  const g = createGame({ name: "tone test", focusZone: ZONE, settings: { geofenceMetres: threshold, role: "hider" } });
  store.setCurrent(g);
  const gf = new Geofence({ Notification: { permission: "granted" }, geolocation: navigator.geolocation });
  gf.init();
  return gf;
}

function fire(gf, position) {
  // Geofence subscribes via the shared watch's watchPosition callback captured
  // at _startWatch time; drive it the same way the real GPS would.
  gf._onPosition(position);
}

function pillClasses(id = "geofence-pill") {
  const el = globalThis.document.getElementById(id);
  return el?.classList;
}

test("comfortably inside the zone → green, not neutral gray", () => {
  const gf = boot();
  fire(gf, ZONE.point);
  const c = pillClasses();
  assert.ok(c.contains("pill-ok"), "safe-inside must be green");
  assert.ok(!c.contains("pill-warn"));
  gf.destroy();
});

test("near the edge but still inside → still green (it's IN the zone)", () => {
  const gf = boot();
  fire(gf, at(0.001, 0)); // establish a baseline band
  fire(gf, at(0.0036, 0)); // ~near the edge, still inside
  const c = pillClasses();
  assert.ok(c.contains("pill-ok"), "near-but-inside is still green — 'in zone' is the whole story for this pill");
  assert.ok(!c.contains("pill-warn"));
  gf.destroy();
});

test("outside the zone → red", () => {
  const gf = boot();
  fire(gf, ZONE.point); // baseline inside
  fire(gf, at(0.02, 0)); // well outside a 500 m radius
  const c = pillClasses();
  assert.ok(c.contains("pill-warn"), "outside must be red");
  assert.ok(!c.contains("pill-ok"));
  gf.destroy();
});

test("re-entering the zone after being outside flips back to green", () => {
  const gf = boot();
  fire(gf, ZONE.point);
  fire(gf, at(0.02, 0));
  assert.ok(pillClasses().contains("pill-warn"));
  fire(gf, ZONE.point);
  const c = pillClasses();
  assert.ok(c.contains("pill-ok"), "back inside → green again");
  assert.ok(!c.contains("pill-warn"));
  gf.destroy();
});
