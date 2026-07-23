// Phase 44 (Track B 3/3): forward a seeker ping to the hider over FCM.
//
// This is the last hop that makes the seeker-close alert work on a LOCKED hider.
// The socket relay already reaches a FOREGROUND hider; but a backgrounded WebView
// is suspended in Doze, so the socket "location" event never lands. So on every
// seeker ping the server ALSO sends a high-priority FCM data message to the
// hider's registered token — which wakes the app even when locked, so
// native-push.js can run evaluateApproach and post a local notification.
//
// Kept off server.js (importable, testable without booting the listener). It is a
// thin orchestration: look up the token, send, and evict a dead one. Crucially it
// preserves the relay's founding principle — the server forwards the seeker's RAW
// coordinates and NOTHING else. It does not know the hider's zone, does not
// compute distance, does not decide whether the alert should fire. The hider's own
// phone does all of that against its LOCAL focusZone (Phase 12 evaluateApproach).
// The server stays zone-blind.

// Forward one seeker ping. `registry` is the HiderTokenRegistry, `fcm` the
// createFcm() wrapper, `code` the session, `payload` the {lat,lng,at} ping.
// Resolves to a small status object (never throws — a send failure must not take
// down the socket handler). When FCM reports the token is dead, evict it so we
// stop trying.
export async function forwardPingToHider({ registry, fcm, code, payload }) {
  if (!fcm?.enabled) return { forwarded: false, reason: "fcm-disabled" };
  const token = registry?.lookup?.(code);
  if (!token) return { forwarded: false, reason: "no-token" };
  if (!payload || !Number.isFinite(payload.lat) || !Number.isFinite(payload.lng)) {
    return { forwarded: false, reason: "bad-payload" };
  }
  // RAW coordinates only — the hider's phone computes the alert locally. `type`
  // lets native-push.js route the message; `at` lets the client dedupe/stamp.
  const res = await fcm.sendData(token, {
    type: "seeker-location",
    lat: payload.lat,
    lng: payload.lng,
    at: payload.at || Date.now(),
    code,
  });
  if (res?.drop) registry?.drop?.(code, token);
  return { forwarded: !!res?.ok, reason: res?.reason };
}
