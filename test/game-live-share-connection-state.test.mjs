// Phase 47 (playtest fix) game test: "the red dot doesn't update" + "make it
// instantaneous".
//
// Two independent regressions this pins:
//   1. The default outbound emit cadence is no longer throttled to once a
//      minute — a fresh LiveShare (no emitIntervalMs override) emits on every
//      new fix.
//   2. A dropped relay connection is now VISIBLE in the pill instead of
//      leaving stale text sitting there — the actual bug shape a hider hits
//      when the backend's free-tier dyno naps or the network hiccups: no
//      error, no throw, just a red dot that silently stops moving.
//
// Pill text is asserted against a real (if minimal) fake DOM — same pattern
// pill-stack.test.mjs uses — so this exercises the real createPill/_writePill
// path, not just internal state.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });

// --- minimal fake DOM (mirrors pill-stack.test.mjs) -------------------------
function makeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: tag, id: "", _text: "", onclick: null, children: [], attrs: {}, className: "",
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

function pillText(doc, id) {
  const el = doc.getElementById(id);
  const span = el?.children.find((c) => c.className === "pill-text");
  return span?.textContent ?? null;
}

globalThis.document = makeDoc();

const { LiveShare, DEFAULT_EMIT_INTERVAL_MS } = await import("../src/live-share.js");

function makeMockGeo() {
  let handler = null;
  return {
    watchPosition(onPos) { handler = onPos; return 1; },
    clearWatch() { handler = null; },
    fire(coords) { handler?.({ coords }); },
  };
}

// Captures outbound emits; separately exposes registered handlers so a test
// can simulate an inbound/lifecycle event exactly like the server would fire it.
function makeMockTransport() {
  const listeners = new Map();
  const emitted = [];
  return {
    emitted,
    on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); },
    off: (ev, fn) => listeners.get(ev)?.delete(fn),
    emit: (ev, payload) => emitted.push({ ev, payload }),
    trigger(ev, payload) { for (const fn of listeners.get(ev) || []) fn(payload); },
    listenerCount(ev) { return listeners.get(ev)?.size || 0; },
  };
}

test("default emitIntervalMs is 0 — instantaneous, not once-a-minute", () => {
  assert.equal(DEFAULT_EMIT_INTERVAL_MS, 0);
});

test("with no emitIntervalMs override, back-to-back fixes both emit (no artificial throttle)", () => {
  globalThis.document = makeDoc();
  const geo = makeMockGeo();
  const transport = makeMockTransport();
  const share = new LiveShare({ transport, geolocation: geo });
  share.startAsSeeker("1234");
  geo.fire({ latitude: 1, longitude: 2 });
  geo.fire({ latitude: 1.0001, longitude: 2 }); // fires in the same millisecond in a real GPS burst
  const emits = transport.emitted.filter((e) => e.ev === "share-location");
  assert.equal(emits.length, 2, "both fixes reach the relay — no 60 s hold-up");
  share.stop();
});

test("setTransport arms connect/disconnect listeners exactly once per transport instance", () => {
  globalThis.document = makeDoc();
  const transport = makeMockTransport();
  const share = new LiveShare({});
  share.setTransport(transport);
  share.setTransport(transport); // reusing the same socket (re-opening the sheet) must not double-bind
  assert.equal(transport.listenerCount("connect"), 1);
  assert.equal(transport.listenerCount("disconnect"), 1);
});

test("seeker pill: connect then a dropped relay connection surfaces a visible warning, not stale silence", () => {
  const doc = makeDoc();
  globalThis.document = doc;
  const geo = makeMockGeo();
  const transport = makeMockTransport();
  const share = new LiveShare({ transport, geolocation: geo });
  share.startAsSeeker("1234");
  geo.fire({ latitude: 1, longitude: 2 });
  assert.match(pillText(doc, "live-share-pill"), /^Sharing/, "sanity: normal sharing text first");

  transport.trigger("disconnect");
  assert.match(pillText(doc, "live-share-pill"), /Disconnected/i, "connection loss is now visible in the pill");

  transport.trigger("connect");
  assert.match(pillText(doc, "live-share-pill"), /Connected/i, "reconnect is reflected too");
  share.stop();
});

test("hider pill: a relay drop while waiting for a ping is visible, not a frozen 'Waiting…'", () => {
  const doc = makeDoc();
  globalThis.document = doc;
  const transport = makeMockTransport();
  const share = new LiveShare({ transport, geolocation: null });
  share.startAsHider("1234");
  assert.match(pillText(doc, "live-share-pill"), /Waiting for a seeker ping/);

  transport.trigger("disconnect");
  assert.match(pillText(doc, "live-share-pill"), /Disconnected/i);
  share.stop();
});

test("a connect/disconnect event before any role is set is a silent no-op (nothing to render yet)", () => {
  globalThis.document = makeDoc();
  const transport = makeMockTransport();
  const share = new LiveShare({ transport });
  assert.doesNotThrow(() => transport.trigger("connect"));
  assert.doesNotThrow(() => transport.trigger("disconnect"));
});
