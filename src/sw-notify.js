// Phase 17 (fix #5): SW-first notification with an ACK-or-page-fallback.
//
// The page prefers the service worker's showNotification so the alert lands
// in the system tray and survives a backgrounded tab (Phase 9 §C4). But
// postMessage is fire-and-forget: an OLD active SW during the upgrade window
// (v75 introduced the GEOFENCE_NOTIFY handler; anything older drops it) had
// no way to signal that it silently ignored the message, so the page-side
// fallback was skipped and the hider got no alert for the very session where
// the notification mattered most.
//
// This helper sends the message on a MessageChannel, waits for an ack on the
// port for `TIMEOUT_MS`, and fires the page-side fallback if no ack arrives.
// A new SW responds within a few ms, so the timeout is dead code on healthy
// installs; the cost is only paid when the SW is stale or missing.
//
// Extracted because geofence.js AND live-share.js need the exact same shape.
// Any future notification producer joins by calling this too.

const TIMEOUT_MS = 400;

// `payload` MUST include a `type` field that matches a handler in service-worker.js.
// `firePage` is the caller's page-side Notification fallback (already permission-checked).
export function notifyViaSwOrPage(payload, firePage) {
  const sw = typeof navigator !== "undefined" && navigator.serviceWorker;
  if (!sw) { firePage(); return; }

  const send = (target) => {
    if (!target?.postMessage) { firePage(); return; }
    // Prefer MessageChannel so the ack does not collide with any other
    // sw.onmessage listeners on the page (there are none today, but this
    // keeps the ack path scoped to the sender). Both ports MUST be closed
    // after the ack window — an open MessagePort keeps the Node event loop
    // alive (and leaks memory in the browser, per spec).
    let acked = false;
    if (typeof MessageChannel === "function") {
      try {
        const chan = new MessageChannel();
        chan.port1.onmessage = (e) => { if (e.data?.ack) acked = true; };
        target.postMessage(payload, [chan.port2]);
        setTimeout(() => {
          try { chan.port1.close(); } catch (_) {}
          if (!acked) firePage();
        }, TIMEOUT_MS);
        return;
      } catch (_) { /* fall through to the plain send */ }
    }
    // Environment without MessageChannel: send without the port and always
    // fall back after the timeout — safer than trusting an unacked send.
    try { target.postMessage(payload); }
    catch (_) { firePage(); return; }
    setTimeout(() => firePage(), TIMEOUT_MS);
  };

  const controller = sw.controller;
  if (controller) return send(controller);
  if (sw.ready?.then) {
    // Not controlled yet (first load post-install). Wait briefly for a
    // registration and then send; if none, fall back immediately.
    let resolved = false;
    sw.ready.then((reg) => { resolved = true; send(reg?.active); }).catch(() => { resolved = true; firePage(); });
    setTimeout(() => { if (!resolved) firePage(); }, TIMEOUT_MS);
    return;
  }
  firePage();
}

// Phase 31.5 (bug): dismiss an outstanding tray notification by tag when its
// feature is turned off (e.g. the hider zone was removed). A notification shown
// by the SW lives in the tray until closed, and ONLY the SW that showed it can
// close it — so this asks the SW to run `getNotifications({tag})` → `close()`.
//
// Returns true if the request was dispatched to a SW, false if there is no SW
// to ask (nothing to clean up in that case — a page-only environment never
// posted a tray notification). Fire-and-forget: there is no ack, because a
// missed clear just leaves a stale notification the next fire/clear replaces.
export function clearNotification(tag) {
  if (!tag) return false;
  const sw = typeof navigator !== "undefined" && navigator.serviceWorker;
  if (!sw) return false;
  const target = sw.controller || null;
  const post = (t) => { try { t?.postMessage?.({ type: "CLEAR_NOTIFY", tag }); } catch (_) { /* target gone */ } };
  if (target) { post(target); return true; }
  if (sw.ready?.then) { sw.ready.then((reg) => post(reg?.active)).catch(() => {}); return true; }
  return false;
}
