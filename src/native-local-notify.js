// Phase 44 (Track B 3/3): post a seeker-close alert as a LOCAL notification.
//
// When the FCM data message wakes a locked hider, the web Notification API path
// (src/live-share.js `_fireNotification`) isn't the right tool — it's built for a
// foreground tab and won't reliably show from a backgrounded/locked WebView. A
// @capacitor/local-notifications notification does, so on the native shell the
// hider's seeker-close alert goes out this way instead. Off-device this module is
// inert and the web path is used, unchanged.
//
// Mirrors the channel/style contract native-geofence.js uses for the geofence
// alert: "Off" suppresses entirely (Phase 33), "silent" routes to a LOW-importance
// channel, everything else alerts. The channels are created natively (documented
// manual half); this JS only selects one, which is the tested part.

import { isNativeCapacitor } from "./bg-spike.js";

export const SEEKER_CLOSE_CHANNEL = "jltg-seeker-close";
export const SEEKER_CLOSE_CHANNEL_SILENT = "jltg-seeker-close-silent";

// Pure: map a notify ({title,body}) + alert style to a LocalNotifications object,
// or null when the style is "Off". Deterministic (no Date) so it's unit-tested;
// the caller adds the schedule.
export function seekerCloseNotification(notify, id, alertStyle = "vibrate-tone") {
  if (!notify || alertStyle === "off") return null;
  const silent = alertStyle === "silent";
  return {
    id,
    title: notify.title,
    body: notify.body || "",
    channelId: silent ? SEEKER_CLOSE_CHANNEL_SILENT : SEEKER_CLOSE_CHANNEL,
    group: SEEKER_CLOSE_CHANNEL,
    ongoing: false,
  };
}

let _LN = null;
let _lnReady = null;
let _nextId = 3000; // distinct from the geofence band (2000+) and spike (1000+)

async function loadLN() {
  if (_LN) return _LN;
  if (!_lnReady) {
    _lnReady = import("../vendor/capacitor-core.js").then(({ registerPlugin }) => {
      _LN = registerPlugin("LocalNotifications");
    });
  }
  await _lnReady;
  return _LN;
}

// Post a seeker-close local notification. Returns the posted id, or null if
// suppressed ("Off"), off-device, or the plugin is unavailable. `plugins.LN` is
// injectable so the flow is unit-tested without a phone.
export async function postSeekerCloseNotification(notify, { alertStyle = "vibrate-tone", plugins = null, isNative = isNativeCapacitor } = {}) {
  if (!isNative()) return null;
  const payload = seekerCloseNotification(notify, ++_nextId, alertStyle);
  if (!payload) return null;
  const LN = plugins?.LN || (await loadLN());
  if (!LN) return null;
  try {
    await LN.schedule({ notifications: [{ ...payload, schedule: { at: new Date(Date.now() + 50) } }] });
    return payload.id;
  } catch (e) {
    console.warn("native-local-notify: schedule failed", e);
    return null;
  }
}
