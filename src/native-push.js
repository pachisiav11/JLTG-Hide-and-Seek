// Phase 43 (Track B 2/3): the hider's FCM device-token acquisition.
//
// For the seeker-close alert to reach a LOCKED hider, the server must be able to
// push to the hider's phone (Phase 44 forwards each seeker ping as a high-priority
// FCM message). That requires the hider's FCM device token, which only the device
// itself can mint — via @capacitor/push-notifications. This module gets that token.
//
// It is native-only: `isNativeCapacitor()` is false in a browser/PWA/node, where
// there is no FCM and this returns null, so the web live-share path is untouched.
// Phase 44 extends this module with the RECEIVE half (handle the data message →
// evaluateApproach → local notification); this phase is just the token.

import { isNativeCapacitor } from "./bg-spike.js";

let _pnBox = null;
// Boxed in a plain object, never returned bare from an async function — a bare
// Capacitor plugin proxy makes the JS engine treat the returned value as a
// thenable (its catch-all `get` trap answers `.then` with a callable), which
// permanently hangs the async function's own promise. See native-channels.js's
// loadLNBox() for the full mechanism — this is the identical bug, which meant
// getHiderPushToken()/initHiderPushReceiver() below could never resolve.
async function loadPushPluginBox() {
  if (_pnBox) return _pnBox;
  try {
    const { registerPlugin } = await import("../vendor/capacitor-core.js");
    _pnBox = { PN: registerPlugin("PushNotifications") };
  } catch (e) {
    console.warn("native-push: could not load PushNotifications plugin", e);
    _pnBox = { PN: null };
  }
  return _pnBox;
}

// Resolve the device's FCM registration token, or null if unavailable (not
// native, permission denied, plugin missing, or no token within `timeoutMs`).
// Injectable (`isNative`, `plugin`) so the flow is unit-testable without a phone.
export async function getHiderPushToken({ isNative = isNativeCapacitor, plugin = null, timeoutMs = 8000 } = {}) {
  if (!isNative()) return null;
  const PN = plugin || (await loadPushPluginBox()).PN;
  if (!PN) return null;

  // Ask for notification permission; a hard denial means no token. A plugin that
  // doesn't implement requestPermissions (or throws) is not fatal — register()
  // may still surface a token on platforms that grant by default.
  try {
    const perm = await PN.requestPermissions?.();
    if (perm && perm.receive && perm.receive !== "granted") return null;
  } catch { /* continue to register() */ }

  let resolveToken;
  const tokenPromise = new Promise((r) => { resolveToken = r; });
  let regHandle = null;
  let errHandle = null;
  try {
    // Capacitor's addListener resolves to a handle; attach BOTH before register()
    // so the 'registration' event can't fire before we're listening.
    regHandle = await PN.addListener?.("registration", (t) => resolveToken(t?.value || null));
    errHandle = await PN.addListener?.("registrationError", () => resolveToken(null));
    await PN.register?.();
  } catch (e) {
    console.warn("native-push: register failed", e);
    resolveToken(null);
  }

  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r(null), timeoutMs); });
  const token = await Promise.race([tokenPromise, timeout]);
  clearTimeout(timer);
  try { regHandle?.remove?.(); } catch { /* ignore */ }
  try { errHandle?.remove?.(); } catch { /* ignore */ }
  return token;
}

// Phase 44 (Track B 3/3), extended by Phase 51: the RECEIVE half. Two message
// shapes now arrive on this same listener, routed by `data.type`:
//
//   "seeker-location"   — raw coords (Phase 44, unchanged). Handed to
//                          `onSeekerCoords` so the app, if it's alive enough to
//                          receive this, keeps the pill/red dot current. Does
//                          NOT decide whether to alert any more — see below.
//   "seeker-close-alert"— Phase 51: the server has ALREADY decided a crossing
//                          happened (relay-forward.js checkServerApproach, run
//                          against the hider's zone the server was told about)
//                          and sent a genuine FCM notification message. If the
//                          app is alive to see this event at all, `onCloseAlert`
//                          posts the SAME local notification a foreground alert
//                          would, for a consistent look; if the app is fully
//                          dead, Android already displayed the message's own
//                          `notification` block with no app code involved,
//                          which is the entire point of this design — a data
//                          message alone can't reach a killed process.
//
// Deciding the crossing only once (server-side, for this path) rather than
// twice avoids a duplicate alert racing the server's own when the app happens
// to be alive to also compute it — see LiveShare._onSeekerPingSilent.
//
// Returns an unsubscribe fn. Inert off-device (no FCM in a browser/PWA/node).
export async function initHiderPushReceiver({ isNative = isNativeCapacitor, plugin = null, onSeekerCoords, onCloseAlert } = {}) {
  if (!isNative() || (typeof onSeekerCoords !== "function" && typeof onCloseAlert !== "function")) return () => {};
  const PN = plugin || (await loadPushPluginBox()).PN;
  if (!PN) return () => {};

  const handle = (n) => {
    const d = n?.data || {};
    const type = d.type || "seeker-location"; // untyped = the original Phase 44 shape
    if (type === "seeker-location") {
      if (typeof onSeekerCoords !== "function") return;
      const lat = Number(d.lat), lng = Number(d.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      try { onSeekerCoords({ lat, lng, at: Number(d.at) || Date.now() }); }
      catch (e) { console.warn("native-push: onSeekerCoords threw", e); }
      return;
    }
    if (type === "seeker-close-alert") {
      if (typeof onCloseAlert !== "function") return;
      // The notification's title/body live at the top level of the event, not
      // inside `data` (that's where FCM's `notification` block surfaces).
      const title = n?.title || d.title;
      if (!title) return;
      try { onCloseAlert({ title, body: n?.body || d.body || "" }); }
      catch (e) { console.warn("native-push: onCloseAlert threw", e); }
    }
    // Any other/foreign type is silently ignored — not our message.
  };

  const handles = [];
  try {
    // Foreground / woken delivery carries the data on the notification.
    handles.push(await PN.addListener?.("pushNotificationReceived", (n) => handle(n)));
    // A tap on a surfaced notification (if the OS showed one) carries it too.
    handles.push(await PN.addListener?.("pushNotificationActionPerformed", (a) => handle(a?.notification)));
  } catch (e) {
    console.warn("native-push: could not attach receiver", e);
  }
  return () => { for (const h of handles) { try { h?.remove?.(); } catch { /* ignore */ } } };
}
