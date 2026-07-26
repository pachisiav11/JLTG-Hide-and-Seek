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
//
// (Phase 51 below adds a SEPARATE, narrower exception to that for the
// locked/killed-device case — see checkServerApproach.)

import { evaluateApproach } from "./src/geo.js";

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
  // RAW coordinates only — used client-side to update the pill/red dot when
  // the app happens to be alive to receive it. `type` lets native-push.js
  // route the message; `at` lets the client dedupe/stamp.
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

// Phase 51: the locked/killed-device half of the seeker-close alert.
//
// forwardPingToHider (above) keeps the relay zone-blind — it forwards raw
// coordinates and trusts the hider's own phone to decide whether to alert.
// That works whenever the app is alive enough to run JS, but a WebView the
// OS has fully killed runs no JS at all; only a genuine FCM *notification*
// message (not data) gets displayed in that case, by Android itself. Someone
// has to decide WHETHER to show it — and if nobody has the hider's zone, the
// only honest options are "never alert a killed app" or "the server decides".
// The user explicitly authorized the latter (cloud compute is fine so long as
// it's error-free while locked), so this is a deliberate, narrow exception to
// "the relay never learns game state": a hider's zone CENTRE + a distance
// THRESHOLD + their alert style, nothing else, registered only while they are
// actively sharing a session (HiderTokenRegistry.registerZone) and dropped
// with the rest of that session's state on disconnect/expiry.
//
// Mirrors evaluateApproach's own edge-triggered "once per crossing" semantics
// (imported from geo.js, the exact function the client uses) so a hider gets
// identical behaviour whether their phone was awake or not to compute it
// itself. These channel ids MUST match native-local-notify.js's
// SEEKER_CLOSE_CHANNEL / SEEKER_CLOSE_CHANNEL_SILENT — duplicated as plain
// strings rather than imported, since that module pulls in browser-oriented
// code this server process has no business loading.
const SEEKER_CLOSE_CHANNEL = "jltg-seeker-close";
const SEEKER_CLOSE_CHANNEL_SILENT = "jltg-seeker-close-silent";

export async function checkServerApproach({ registry, fcm, code, payload }) {
  if (!fcm?.enabled) return { alerted: false, reason: "fcm-disabled" };
  if (!payload || !Number.isFinite(payload.lat) || !Number.isFinite(payload.lng)) {
    return { alerted: false, reason: "bad-payload" };
  }
  const zone = registry?.lookupZone?.(code);
  if (!zone) return { alerted: false, reason: "no-zone" };
  // "Off" is a hider's explicit choice not to be alerted at all — honour it
  // here too, not just on-device, so a fully-killed app can't bypass it just
  // because there's no local code left running to enforce it.
  if (zone.alertStyle === "off") return { alerted: false, reason: "alert-style-off" };
  const token = registry?.lookup?.(code);
  if (!token) return { alerted: false, reason: "no-token" };

  const prior = registry?.getApproachState?.(code) || null;
  const { state, notify } = evaluateApproach({
    seekerPoint: { lat: payload.lat, lng: payload.lng },
    zoneCentre: zone.point,
    thresholdM: zone.thresholdM,
    prior,
  });
  registry?.setApproachState?.(code, state);
  if (!notify) return { alerted: false, reason: "no-crossing" };

  const channelId = zone.alertStyle === "silent" ? SEEKER_CLOSE_CHANNEL_SILENT : SEEKER_CLOSE_CHANNEL;
  const res = await fcm.sendNotification(token, {
    title: notify.title,
    body: notify.body,
    channelId,
    data: { type: "seeker-close-alert", code },
  });
  if (res?.drop) registry?.drop?.(code, token);
  return { alerted: !!res?.ok, reason: res?.reason };
}
