// Phase 15 game test: a server-side `session-error` reaches the client.
//
// Regression pin for review finding #3 (2026-07-21). server.js:257-262
// already emits `session-error` for a bad code or wrong role, but no client
// listener existed — the seeker kept publishing to a room they never joined
// and the hider's pill said "Waiting for a seeker ping…" forever. A mistyped
// code was a silent failure.
//
// The scenario simulates exactly that: the hider types "ab" (below the
// server's 3-char minimum), the server responds with session-error, and this
// test asserts the client tears down cleanly, writes the error to the pill,
// and invokes the app-side onError callback so a toast can surface.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/turf-env.mjs";
import { LiveShare } from "../src/live-share.js";

function makeTransport() {
  const listeners = new Map();
  const emitted = [];
  return {
    listeners, emitted,
    on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); },
    off: (ev, fn) => listeners.get(ev)?.delete(fn),
    emit: (ev, payload) => emitted.push({ ev, payload }),
    fire: (ev, payload) => { for (const fn of listeners.get(ev) || []) fn(payload); },
  };
}

test("game 1: session-error on the hider path invokes onError and clears role/code", () => {
  const transport = makeTransport();
  const errors = [];
  const share = new LiveShare({ transport, geolocation: null, Notification: null, onError: (m) => errors.push(m) });
  share.startAsHider("ab"); // too short — the server would reject
  assert.equal(share.role, "hider");
  assert.equal(share.code, "ab");
  // Server sends the error.
  transport.fire("session-error", "Invalid session code.");
  // Client tore down.
  assert.equal(share.role, null, "role cleared on session-error");
  assert.equal(share.code, null, "code cleared on session-error");
  assert.equal(errors.length, 1, "onError callback invoked exactly once");
  assert.match(errors[0], /Invalid session/);
});

test("game 2: session-error on the seeker path tears down publish + handlers", () => {
  const transport = makeTransport();
  const errors = [];
  // Phase 23 (fix #11): seeker publishes via watchPosition, not
  // setInterval + getCurrentPosition. The teardown must call clearWatch
  // with the id watchPosition returned.
  const cleared = [];
  const geolocation = {
    watchPosition: () => 99,
    clearWatch: (id) => cleared.push(id),
  };
  const share = new LiveShare({ transport, geolocation, Notification: null, onError: (m) => errors.push(m) });
  share.startAsSeeker("xy"); // bad code — server rejects
  // Session-error arrives.
  transport.fire("session-error", "Invalid session code.");
  assert.equal(share.role, null);
  assert.equal(errors.length, 1);
  // The teardown must have killed the watch — the GPS subscription cannot
  // outlive the failed session.
  assert.deepEqual(cleared, [99], "clearWatch called on teardown");
  // And the session-error listener itself is unregistered.
  assert.equal(transport.listeners.get("session-error")?.size || 0, 0,
    "session-error listener removed on teardown");
});

test("game 3: session-error with an empty/missing message still surfaces a fallback string", () => {
  const transport = makeTransport();
  const errors = [];
  const share = new LiveShare({ transport, geolocation: null, Notification: null, onError: (m) => errors.push(m) });
  share.startAsHider("abc123");
  transport.fire("session-error"); // no payload
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Session join failed|failed/i);
});

test("game 4: a follow-up successful start after an error rebinds fresh listeners", () => {
  // The teardown clears the session-error handler; a subsequent start must
  // rebind it, otherwise a SECOND join failure would silently hang the way
  // the pre-fix bug did.
  const transport = makeTransport();
  const errors = [];
  const share = new LiveShare({ transport, geolocation: null, Notification: null, onError: (m) => errors.push(m) });
  share.startAsHider("abc123");
  transport.fire("session-error", "First failure.");
  assert.equal(errors.length, 1);
  // Second attempt with a good code — the client thinks it succeeded.
  share.startAsHider("goodcode");
  // Simulate a SECOND server rejection.
  transport.fire("session-error", "Second failure.");
  assert.equal(errors.length, 2, "the re-attached listener catches the second error");
  assert.match(errors[1], /Second failure/);
});

test("game 5: onError callback that throws does not break teardown", () => {
  // The app wires onError to `toast()`; if toast blows up (missing DOM), the
  // teardown itself must still complete cleanly.
  const transport = makeTransport();
  const share = new LiveShare({
    transport, geolocation: null, Notification: null,
    onError: () => { throw new Error("toast is angry"); },
  });
  share.startAsHider("abc123");
  assert.doesNotThrow(() => transport.fire("session-error", "boom"));
  assert.equal(share.role, null, "teardown completed despite onError throwing");
});
