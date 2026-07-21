// Phase 22 game test: scheduleSave is a no-op when IndexedDB is unavailable.
//
// Regression pin for observation #10 (2026-07-21). In node:test, calling
// store.setCurrent(game) used to schedule a debounced save that fired
// 500 ms LATER — always past the point where the test that called it had
// returned. The save handler then invoked db.openDB(), which rejected with
// 'IndexedDB is not available in this browser', and printed an autosave-
// failed stack to stderr as an unhandled-rejection-ish artefact. Benign
// in-browser (the browser has indexedDB), but the noise misled reads of the
// test output — a real failure could hide behind three "autosave failed"
// stacks that meant nothing.
//
// The fix is a single guard: scheduleSave() returns immediately when there
// is no indexedDB. Callers that actually need persistence can still call
// saveNow() directly and handle the reject.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("game 1: scheduleSave is a no-op under node:test (no indexedDB, no scheduled work)", async () => {
  // Confirm the environment first, so a Node that grew an indexedDB global
  // one day would fail this loudly instead of silently masking the guard.
  assert.equal(typeof indexedDB, "undefined", "node has no indexedDB — the whole point of this fix");

  const store = await import("../src/store.js");
  // scheduleSave() should return without scheduling anything. If it did
  // schedule, the 500 ms setTimeout would keep the event loop alive past
  // this function and eventually print an autosave-failed stack.
  const before = process._getActiveHandles ? process._getActiveHandles().length : 0;
  store.scheduleSave();
  const after = process._getActiveHandles ? process._getActiveHandles().length : 0;
  assert.equal(after, before, "no new timer was created");
});

test("game 2: setCurrent does not leave a timer behind", async () => {
  // The exact user-level call that caused the noise: setCurrent → scheduleSave.
  // With the guard in place, setCurrent still updates state and emits, but
  // does not schedule a save when there is no db to save to.
  const store = await import("../src/store.js");
  const fake = { id: "test-x", zones: [], gameArea: null };
  const before = process._getActiveHandles ? process._getActiveHandles().length : 0;
  store.setCurrent(fake);
  const after = process._getActiveHandles ? process._getActiveHandles().length : 0;
  assert.equal(after, before, "setCurrent must not leave a timer behind in node");
  assert.equal(store.getCurrent(), fake, "state still updates");
});

test("game 3: the source implements the exact guard, not a broader one", () => {
  // A guard tied to `typeof window` or `typeof document` would break a
  // headless browser test runner (jsdom) where indexedDB is polyfilled but
  // window is not the DOM's window. The guard has to check for indexedDB
  // itself — the one thing the autosave actually needs.
  const src = readFileSync(new URL("../src/store.js", import.meta.url), "utf8");
  assert.match(src, /if \(typeof indexedDB === "undefined"\) return;/,
    "the guard must be exactly on indexedDB, not a broader environment check");
});
