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

async function loadPushPlugin() {
  try {
    const { registerPlugin } = await import("../vendor/capacitor-core.js");
    return registerPlugin("PushNotifications");
  } catch (e) {
    console.warn("native-push: could not load PushNotifications plugin", e);
    return null;
  }
}

// Resolve the device's FCM registration token, or null if unavailable (not
// native, permission denied, plugin missing, or no token within `timeoutMs`).
// Injectable (`isNative`, `plugin`) so the flow is unit-testable without a phone.
export async function getHiderPushToken({ isNative = isNativeCapacitor, plugin = null, timeoutMs = 8000 } = {}) {
  if (!isNative()) return null;
  const PN = plugin || (await loadPushPlugin());
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
