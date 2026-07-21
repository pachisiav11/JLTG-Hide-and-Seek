// Phase 17 game test: SW ack-or-fallback for the notification path.
//
// Regression pin for review finding #5 (2026-07-21). The install handler in
// service-worker.js intentionally does NOT skipWaiting() — a new SW waits
// behind an "update available" banner (Phase 12 behaviour). During that
// window the OLD active SW is still in control; before Phase 9 (v75) it had
// no GEOFENCE_NOTIFY handler at all, so `postMessage(GEOFENCE_NOTIFY)` was
// silently dropped and the page-side fallback was skipped ("sent=true"). The
// hider lost geofence alerts for the very session an upgrade was pushed.
//
// The fix (src/sw-notify.js): send the message on a MessageChannel; if the
// SW doesn't ACK within TIMEOUT_MS (400 ms), fire the page-side Notification
// as a fallback. A healthy SW (v79+) acks synchronously — the fallback path
// is dead code on healthy installs; the cost is only paid when the SW is
// stale or missing.
import test from "node:test";
import assert from "node:assert/strict";

const noopEvents = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.window = Object.assign(globalThis.window || {}, noopEvents);
globalThis.document = globalThis.document || { ...noopEvents, visibilityState: "visible" };

const { notifyViaSwOrPage } = await import("../src/sw-notify.js");

function makeSw({ ack = true } = {}) {
  const posted = [];
  const controller = {
    postMessage: (m, transfer) => {
      posted.push(m);
      if (ack && transfer && transfer[0]) {
        try { transfer[0].postMessage({ ack: true }); } catch (_) { /* port closed */ }
      }
    },
  };
  return { posted, controller };
}

test("game 1: SW that acks — page fallback is NOT fired even after the timeout", async () => {
  const { posted, controller } = makeSw({ ack: true });
  Object.defineProperty(globalThis, "navigator", { value: { serviceWorker: { controller } }, configurable: true, writable: true });
  const fired = [];
  notifyViaSwOrPage({ type: "GEOFENCE_NOTIFY", title: "T", body: "b", tag: "test" }, () => fired.push(1));
  assert.equal(posted.length, 1, "SW got the message");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fired.length, 0, "acking SW means no page fallback ever fires");
});

test("game 2: STALE SW that never acks — page fallback fires after the timeout", async () => {
  // This is the whole failure the fix exists for: an old active SW without the
  // GEOFENCE_NOTIFY handler. postMessage lands somewhere, the SW doesn't
  // respond, and the page-side Notification MUST fire so the hider still gets
  // an alert.
  const { posted, controller } = makeSw({ ack: false });
  Object.defineProperty(globalThis, "navigator", { value: { serviceWorker: { controller } }, configurable: true, writable: true });
  const fired = [];
  notifyViaSwOrPage({ type: "GEOFENCE_NOTIFY", title: "T", body: "b", tag: "test" }, () => fired.push(1));
  assert.equal(posted.length, 1, "we still send to the SW so a healthy one takes over next time");
  // Not yet — the timeout hasn't fired.
  assert.equal(fired.length, 0, "no fallback yet — waiting for the ack window");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fired.length, 1, "no ack within the window → page fallback fires");
});

test("game 3: no SW at all — page fallback fires immediately, no wait", () => {
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
  const fired = [];
  notifyViaSwOrPage({ type: "GEOFENCE_NOTIFY", title: "T", body: "b" }, () => fired.push(1));
  assert.equal(fired.length, 1, "immediate fallback when there is no serviceWorker");
});

test("game 4: SW registered but no controller yet (first load) — falls back via ready.active if it acks", async () => {
  // First load post-install: navigator.serviceWorker exists but controller is
  // null until the page reloads. sw.ready resolves to the registration with an
  // active worker. If the active worker acks, no page fallback.
  const posted = [];
  const readyReg = {
    active: {
      postMessage: (m, transfer) => {
        posted.push(m);
        if (transfer && transfer[0]) { try { transfer[0].postMessage({ ack: true }); } catch (_) {} }
      },
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { serviceWorker: { controller: null, ready: Promise.resolve(readyReg) } },
    configurable: true, writable: true,
  });
  const fired = [];
  notifyViaSwOrPage({ type: "GEOFENCE_NOTIFY", title: "T", body: "b" }, () => fired.push(1));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(posted.length, 1, "ready.active took the message");
  assert.equal(fired.length, 0, "acked → no page fallback");
});

test("game 5: SW registered but ready.active is null — page fallback still fires", async () => {
  // Edge case: sw.ready resolves but the registration has no active worker
  // (rare — usually means the SW is still installing). The helper must still
  // land a notification somehow, not silently drop it.
  const readyReg = { active: null };
  Object.defineProperty(globalThis, "navigator", {
    value: { serviceWorker: { controller: null, ready: Promise.resolve(readyReg) } },
    configurable: true, writable: true,
  });
  const fired = [];
  notifyViaSwOrPage({ type: "GEOFENCE_NOTIFY", title: "T", body: "b" }, () => fired.push(1));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fired.length, 1, "no active worker → immediate page fallback");
});
