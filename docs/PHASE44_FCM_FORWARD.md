# Phase 44 — FCM forward + hider computes locally (Track B 3/3)

**Status:** code + headless tests committed (server forward + client receive +
local-notify, 11 tests). The **device half is manual** — a locked hider actually
buzzing when the seeker crosses the threshold.

This is the payoff of the whole native track: **a seeker-close alert reaches a
LOCKED hider.**

## What this phase does

- **Server** (`relay-forward.js`, `server.js`): on every seeker `share-location`
  ping, in addition to the socket `location` emit (foreground hiders), the server
  looks up the hider's FCM token (Phase 43) and sends a **high-priority data
  message carrying the RAW seeker coordinates** — and nothing else. The server
  stays **zone-blind**: it never learns the hiding zone, never computes distance,
  never decides whether to alert. A dead token is evicted; a missing token or
  disabled FCM is a silent no-op that never disrupts the socket relay.
- **Client** (`src/native-push.js`, `src/native-local-notify.js`,
  `src/live-share.js`): the FCM data message **wakes the hider's app even when
  locked**. `initHiderPushReceiver` extracts the raw coords and feeds them into
  the **same `_onSeekerPing` path** a foreground socket ping uses — so
  `evaluateApproach` runs against the **local** `focusZone.point`, and the pill,
  the red seeker dot (Phase 37), and the alert are the identical, already-tested
  code. On the native shell the alert is posted as a **local notification**
  (`@capacitor/local-notifications`), which shows from a locked/backgrounded
  WebView where the web Notification API can't. Phase 33 "Off" suppresses it;
  "silent" routes to a LOW-importance channel. The once-per-crossing debounce
  (shared `approachState`) means the socket ping and its FCM twin never
  double-alert a foreground hider.

Off-device everything is inert: no FCM, web Notification path unchanged.

## Manual half — device QA

1. Complete the Phase 43 Firebase setup (`docs/PHASE43_FCM_PLUMBING.md`) — the
   forward is a no-op until FCM is enabled (server logs `native push enabled`).
2. Notification channels: create `jltg-seeker-close` (alerting) and
   `jltg-seeker-close-silent` (LOW importance) natively, alongside the Phase 41
   geofence channels.
3. Two devices. Hider joins a session (APK), sets a hiding zone + a close-approach
   threshold, then **locks the phone**. Seeker joins and walks toward the zone.
4. Confirm: when the seeker crosses the threshold, the **locked** hider gets a
   local notification "Seeker close · ~N m from your hiding zone centre", **once**
   per crossing.
5. Foreground the hider mid-session and confirm no double-alert, and that the red
   dot + pill still update.
6. Set alert style **Off** → a crossing posts nothing. **Silent** → posts without
   buzz/tone.

Record results in a `docs/PHASE44_RESULTS.md`.

## Files

- `relay-forward.js` — `forwardPingToHider` (lookup → send raw coords → evict dead token).
- `server.js` — forward on each `share-location` (fire-and-forget alongside the socket emit).
- `src/native-push.js` — `initHiderPushReceiver` (FCM data message → raw coords).
- `src/native-local-notify.js` — `postSeekerCloseNotification` + channel/style mapping.
- `src/live-share.js` — `initPushReceiver` / `postLocalNotify` hooks; native alerts
  via local notification; FCM coords routed through `_onSeekerPing`.
- `src/app.js` — wire the receiver + local-notify poster into `LiveShare`.
- `test/relay-forward.test.mjs`, `test/native-seeker-close.test.mjs` — 11 tests
  (server zone-blind forward + end-to-end locked-hider local alert). The Phase 12
  `evaluateApproach` tests carry over unchanged.
- SW cache → **v105** (new shell asset `src/native-local-notify.js`).
