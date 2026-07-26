// Phase 12 (§C5): live seeker→hider location share + close-approach alert.
//
// Rolls back part of the "no online multiplayer" non-goal from PLAYTEST_IDEAS
// at the user's request (2026-07-20): a narrow one-way channel carrying only
// coordinates, not game state, from a session's seeker device to a session's
// hider device. Full state sync stays out of scope. The rest of the app is
// unchanged.
//
// Why: after Phase 5's paste intake landed, the hider still had no LIVE view
// of where the seekers were — every paste is a snapshot, always stale by the
// time it's read. This closes that gap without reviving the Phase-13 full
// relay. The hider's device automatically compares the seeker's live point to
// the Hider zone centre every update and fires a system notification (via the
// Phase 9 SW path) when the distance drops below a threshold.

import * as store from "./store.js";
import { notifyViaSwOrPage, clearNotification } from "./sw-notify.js";
import { formatDistance, evaluateApproach } from "./geo.js";
import { createPill } from "./pill-stack.js";
import { geoWatch, GeoWatch } from "./geo-watch.js";
import { isNativeCapacitor } from "./bg-spike.js";

// Phase 51: formatDistance/evaluateApproach now LIVE in geo.js (pure, no
// window/DOM) so the server can share the exact same seeker-close decision
// instead of a second hand-written copy — see relay-forward.js. Re-exported
// here unchanged so every existing caller (games.js, the test suite) keeps
// importing them from live-share.js.
export { formatDistance, evaluateApproach };

// Notification tag — shared with the SW so a stale seeker-close alert can be
// dismissed from the tray when sharing stops (Phase 31.5 bug).
const SEEKER_CLOSE_TAG = "jltg-seeker-close";

// Phase 28 (req #4): parse a user-typed "Custom" approach threshold in
// kilometres into metres for storage in `settings.approachThresholdM`.
//
// The presets (500 m / 1 / 2 / 5 km) cover the common cases; this lets a hider
// dial in an arbitrary distance for a larger or oddly-sized board. Kept pure so
// the reject/clamp rules are unit-tested without any DOM. Returns null for junk
// (empty, non-numeric, NaN, ≤ 0, ±Infinity) so the caller can fall back to a
// preset rather than silently storing a bogus 0/negative threshold; a valid
// value is rounded to whole metres and clamped to MAX_APPROACH_KM (50 km) so a
// fat-fingered "500" (km) can't set an alert that never fires.
export const MAX_APPROACH_KM = 50;
export function parseApproachKm(str) {
  const km = typeof str === "number" ? str : parseFloat(String(str ?? "").trim());
  if (!Number.isFinite(km) || km <= 0) return null;
  const clamped = Math.min(km, MAX_APPROACH_KM);
  return Math.round(clamped * 1000);
}

// Phase 47 (playtest fix): "make it instantaneous" — a seeker's ping now goes
// out as fast as the GPS produces fixes, not once a minute. The old 60 s
// throttle (Phase 23) existed to spare the radio, not to protect the relay;
// the relay already has its own token-bucket rate limit (share-location.js,
// 4/s sustained / 6 burst) as the real safety net, so the client no longer
// needs a redundant, much coarser cap of its own. 0 = "emit on every new fix";
// tests still override this to pin the throttle MECHANISM itself.
export const DEFAULT_EMIT_INTERVAL_MS = 0;

// Session code generator — 4 digits, read aloud by the HIDER to the seeker (see
// games.js's Live location share sheet for the generate/enter role split). Digits only,
// so there's no letter-case or ambiguous-character (0/O, 1/I/L) problem to design around.
export function generateSessionCode() {
  let out = "";
  for (let i = 0; i < 4; i++) out += Math.floor(Math.random() * 10);
  return out;
}

// Client wrapper. Transport is pluggable so tests can inject an in-memory
// event bus without opening a socket. Production callers construct a
// SocketIOTransport from the loaded socket.io-client global.
export class LiveShare {
  constructor({ transport, geolocation = (typeof navigator !== "undefined" ? navigator.geolocation : null), watch = null, bgWatch = null, isNative = isNativeCapacitor, getPushToken = null, initPushReceiver = null, postLocalNotify = null, Notification = (typeof window !== "undefined" ? window.Notification : null), onError = null, onSeekerPoint = null, emitIntervalMs = DEFAULT_EMIT_INTERVAL_MS, now = () => Date.now() } = {}) {
    this.transport = null;
    this._transportBound = null; // the transport instance we last attached connect/disconnect listeners to
    this._connected = null;      // null = unknown (no transport yet), else true/false
    // Phase 36: the seeker rides the shared GeoWatch (one OS watch shared with
    // the geofence + self-dot). Production injects the singleton; a test injects
    // a private GeoWatch or a raw geolocation we wrap here.
    this.watch = watch || (geolocation ? new GeoWatch({ geolocation }) : geoWatch);
    // Phase 42 (Track B): a GeoWatch-COMPATIBLE background watcher for the native
    // shell. When present AND we're on-device, the seeker subscribes to THIS
    // instead of the foreground `watch`, so its GPS keeps streaming to the relay
    // with the phone locked (a foreground-service watcher, Doze-proof per Phase
    // 40). Null / off-device → the foreground path is used, unchanged.
    this.bgWatch = bgWatch;
    this._isNative = isNative;
    // Phase 43 (Track B 2/3): () => Promise<string|null> yielding this device's
    // FCM token. On the Android shell the hider registers it against the session
    // code so the server can push seeker-close alerts to a LOCKED phone (Phase 44).
    // Null / off-device → no registration, socket-only delivery, as before.
    this._getPushToken = getPushToken;
    // Phase 44 (Track B 3/3): the RECEIVE + local-notify hooks for the native
    // shell. `initPushReceiver({onSeekerCoords})` wires the FCM data-message
    // listener that feeds forwarded seeker coords into the same _onSeekerPing path
    // a socket ping uses; `postLocalNotify(notify, {alertStyle})` posts the alert
    // as a local notification (which shows from a locked/backgrounded WebView,
    // unlike the web Notification API). Both null / off-device → web path only.
    this._initPushReceiver = initPushReceiver;
    this._postLocalNotify = postLocalNotify;
    this._pushUnsub = null;
    this._settingsUnsub = null; // Phase 51: store subscription that keeps the relay's copy of the hider's zone fresh
    this.N = Notification;
    this.onError = onError; // (message: string) => void, for a toast the app can wire
    // Phase 37: (point|null) => void — the app wires the red seeker dot to this.
    // Assignable after construction too, since the drawing layer may be built
    // later in boot than LiveShare.
    this.onSeekerPoint = onSeekerPoint;
    this.role = null;
    this.code = null;
    this.approachState = null;
    this._publishTimer = null;
    this._watchUnsub = null;
    this._locationHandler = null;
    this._sessionErrorHandler = null;
    this._pill = null;
    this._lastSeekerPoint = null;
    // Phase 23 (fix #11): watchPosition + throttled emit. `emitIntervalMs`
    // caps outbound share-location cadence; `now` is injectable so tests can
    // step time without waiting real seconds.
    this._emitIntervalMs = emitIntervalMs;
    this._now = now;
    this._lastEmitAt = null; // null = "never yet" so the first fix always fires
    if (transport) this.setTransport(transport);
  }

  // Phase 47: attach (once) to the transport's own connect/disconnect events so
  // a dropped relay connection is VISIBLE instead of leaving the last pill text
  // sitting there looking current. Idempotent per transport instance — games.js
  // creates the Socket.IO client once and reuses it across start/stop cycles, so
  // this must not stack duplicate listeners on repeated setTransport(sameSocket)
  // calls (e.g. re-opening the Live location share sheet).
  setTransport(transport) {
    this.transport = transport;
    if (!transport || this._transportBound === transport) return;
    this._transportBound = transport;
    transport.on?.("connect", () => this._onTransportConnect());
    transport.on?.("disconnect", () => this._onTransportDisconnect());
    transport.on?.("connect_error", () => this._onTransportDisconnect());
  }

  _onTransportConnect() {
    this._connected = true;
    if (this.role === "seeker") this._writePill("📡 Connected · waiting for a GPS fix…");
    else if (this.role === "hider") this._writePill("Connected · waiting for a seeker ping…");
  }

  // A dropped connection (network hiccup, the relay's free-tier dyno asleep,
  // etc.) used to leave the pill frozen on stale text — indistinguishable from
  // "nothing has moved" for a hider staring at a red dot that stopped updating.
  // Socket.IO keeps retrying on its own (default: unlimited attempts with
  // backoff); this just makes the outage visible while that happens instead of
  // silently going stale.
  _onTransportDisconnect() {
    this._connected = false;
    if (this.role) this._writePill("⚠️ Disconnected from relay — retrying…");
  }

  // Bind the session-error listener before anything else. Kept in one place so
  // seeker + hider start paths don't drift and every code path that resets the
  // socket state also re-attaches this handler. The server emits `session-error`
  // for a bad code or wrong role (server.js) — the client used to have no
  // listener at all, so a mistyped code showed the "Sharing…" or "Waiting for
  // a seeker ping…" pill forever with no signal to the user that the join
  // never actually happened.
  _armSessionErrorListener() {
    this._sessionErrorHandler = (message) => this._onSessionError(message);
    this.transport?.on?.("session-error", this._sessionErrorHandler);
  }

  _onSessionError(message) {
    const text = typeof message === "string" && message.trim() ? message : "Session join failed.";
    console.warn("live-share session-error:", text);
    this._writePill(`Session error — ${text}`);
    this._teardown();
    this.role = null;
    this.code = null;
    // The pill stays around with the error text so the user can see it; a
    // subsequent successful start replaces the content. Toast if the caller
    // wired one — the pill alone isn't enough if the user was looking away.
    try { this.onError?.(text); } catch (e) { console.warn("live-share onError callback threw", e); }
  }

  // Seeker side. Publishes GPS to the room named by `code`, throttled to at
  // most once per `emitIntervalMs` (default 0 — every new fix, see Phase 47).
  //
  // Phase 23 (fix #11): switched from `setInterval` + `getCurrentPosition`
  // to `watchPosition` + client-side throttle. The old pattern woke the GPS
  // radio to a fresh fix every 60 s for a 45-minute game (heavy on Android
  // battery); watchPosition keeps a single subscription and rides whatever
  // fixes the device already produces, so the marginal cost of THIS feature
  // is close to zero when the geofence is also on (they share the GPS).
  // Emit cadence is capped by the throttle (0 by default — see Phase 47) so a
  // configured throttle still protects the relay's rate limit (Phase 19).
  startAsSeeker(code) {
    this._teardown();
    this.role = "seeker";
    this.code = code;
    this._armSessionErrorListener();
    this.transport?.emit?.("join-session", { code, role: "seeker" });
    this._ensurePill();
    this._lastEmitAt = null;
    // Phase 36: subscribe to the shared GeoWatch instead of opening a second OS
    // watch. The client-side throttle (Phase 23) still caps the outbound cadence
    // at emitIntervalMs so the relay's rate limit is never approached. No
    // replayLast — the first genuinely-new fix is what the hider is waiting for.
    const onFix = (fix) => {
      const point = { lat: fix.lat, lng: fix.lng };
      const nowMs = this._now();
      if (this._lastEmitAt !== null && nowMs - this._lastEmitAt < this._emitIntervalMs) return;
      this._lastEmitAt = nowMs;
      this.transport?.emit?.("share-location", point);
      this._writePill(`Sharing · ${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`);
    };
    const onErr = (err) => { console.warn("live-share seeker: geolocation error", err); this._writePill("Location unavailable"); };
    // Phase 42: prefer the background watcher on the Android shell so streaming
    // survives a screen-off pocket; the throttle above is identical either way.
    const seekerWatch = (this.bgWatch && this._isNative()) ? this.bgWatch : this.watch;
    this._watchUnsub = seekerWatch.subscribe(onFix, onErr);
  }

  // Hider side. Subscribes to the room and evaluates every incoming ping
  // against the current Hider zone centre.
  startAsHider(code) {
    this._teardown();
    this.role = "hider";
    this.code = code;
    this._armSessionErrorListener();
    this.transport?.emit?.("join-session", { code, role: "hider" });
    this._locationHandler = (payload) => this._onSeekerPing(payload);
    this.transport?.on?.("location", this._locationHandler);
    this._ensurePill();
    this._writePill("Waiting for a seeker ping…");
    this._registerHiderToken(code);
    this._startPushReceiver();
    // Phase 51: keep the server's copy of the zone/threshold/alert-style fresh
    // for as long as this device is the hider in this session, so the
    // locked-device crossing check (relay-forward.js checkServerApproach) is
    // never computing against a stale zone. Native-only — see _registerHiderZone.
    // store.subscribe() calls back immediately with the current game, so this
    // also covers the initial registration — no separate first call needed.
    this._settingsUnsub = store.subscribe(() => this._registerHiderZone(code));
  }

  // Phase 44: on the Android shell, listen for the server's forwarded seeker
  // coords (FCM data message) — updates the pill/red dot only (Phase 51: the
  // crossing DECISION for this path is now made server-side, see
  // _onSeekerPingSilent) — and, separately, a server-decided close alert. Off-
  // device this is inert.
  _startPushReceiver() {
    if (!this._initPushReceiver || !this._isNative()) return;
    Promise.resolve(this._initPushReceiver({
      onSeekerCoords: (pt) => this._onSeekerPingSilent(pt),
      onCloseAlert: (payload) => this._onServerAlert(payload),
    }))
      .then((unsub) => {
        // A stop() between kickoff and resolve → tear the fresh listener down now.
        if (this.role === "hider") this._pushUnsub = unsub;
        else { try { unsub?.(); } catch (_) {} }
      })
      .catch((e) => console.warn("live-share: push receiver init failed", e));
  }

  // Phase 51: tell the relay this hider's zone centre + threshold + alert
  // style, so it can decide the seeker-close crossing itself and reach this
  // device even if its app process has been fully killed by the OS — a data
  // message alone needs the JS bridge alive to react to it, which "locked long
  // enough" doesn't guarantee. Native-only: a web/PWA hider can't be woken in
  // the background at all regardless, so there is nothing for the server-side
  // path to buy them, and no reason to hand it their zone.
  //
  // Guarded on role/code matching the CURRENT session, the same pattern
  // _registerHiderToken uses, so a stale store-subscription callback firing
  // after a session switch can't leak this session's zone into the next one's
  // room (or a dead one's).
  _registerHiderZone(code) {
    if (!this._isNative()) return;
    if (this.role !== "hider" || this.code !== code) return;
    const g = store.getCurrent();
    const point = g?.focusZone?.point;
    if (!point) return; // nothing to register yet — no zone placed
    const thresholdM = Number(g?.settings?.approachThresholdM) || 0;
    const alertStyle = g?.settings?.geofenceAlertStyle || "vibrate-tone";
    this.transport?.emit?.("set-hider-zone", { code, point, thresholdM, alertStyle });
  }

  // Phase 43: on the Android shell, mint this device's FCM token and register it
  // against the session code so the server can push seeker-close alerts to a
  // locked phone (Phase 44). Guarded so a token that resolves after the hider has
  // switched/stopped sessions is not emitted to the wrong (or a dead) room.
  _registerHiderToken(code) {
    if (!this._getPushToken || !this._isNative()) return;
    Promise.resolve(this._getPushToken()).then((token) => {
      if (token && this.role === "hider" && this.code === code) {
        this.transport?.emit?.("register-token", { code, token });
      }
    }).catch((e) => console.warn("live-share: hider token registration failed", e));
  }

  _onSeekerPing(payload) {
    if (!payload || !Number.isFinite(payload.lat) || !Number.isFinite(payload.lng)) return;
    this._lastSeekerPoint = { lat: payload.lat, lng: payload.lng, at: payload.at || Date.now() };
    // Phase 37 (req #7b): hand the latest seeker point to whoever draws the red
    // dot. Fired on every ping, BEFORE the zone check — the hider wants to see
    // where the seeker is even with no Hider zone set.
    try { this.onSeekerPoint?.(this._lastSeekerPoint); } catch (e) { console.warn("onSeekerPoint threw", e); }
    const g = store.getCurrent();
    const centre = g?.focusZone?.point;
    const threshold = Number(g?.settings?.approachThresholdM) || 0;
    if (!centre) {
      this._writePill(`Seeker @ ${payload.lat.toFixed(4)}, ${payload.lng.toFixed(4)} · no hider zone`);
      return;
    }
    const out = evaluateApproach({ seekerPoint: this._lastSeekerPoint, zoneCentre: centre, thresholdM: threshold, prior: this.approachState });
    this.approachState = out.state;
    const d = out.state.distance;
    this._writePill(`Seeker ${formatDistance(d)} from zone centre${threshold ? ` (alert < ${formatDistance(threshold)})` : ""}`);
    if (out.notify) this._fireNotification(out.notify);
  }

  // Phase 51: the FCM-forwarded twin of _onSeekerPing, for when this ping
  // arrived because the relay woke a backgrounded app (not the live socket).
  // Updates the dot + pill exactly the same way, but does NOT decide whether
  // to alert — that decision is now made server-side, against the SAME zone,
  // by relay-forward.js's checkServerApproach (see _registerHiderZone), and
  // delivered separately via _onServerAlert. Computing it AGAIN here would
  // risk a duplicate alert racing the server's own for a phone that happened
  // to still be alive, for no benefit — the server already has everything it
  // needs to decide correctly.
  _onSeekerPingSilent(payload) {
    if (!payload || !Number.isFinite(payload.lat) || !Number.isFinite(payload.lng)) return;
    this._lastSeekerPoint = { lat: payload.lat, lng: payload.lng, at: payload.at || Date.now() };
    try { this.onSeekerPoint?.(this._lastSeekerPoint); } catch (e) { console.warn("onSeekerPoint threw", e); }
    const g = store.getCurrent();
    const centre = g?.focusZone?.point;
    if (!centre) {
      this._writePill(`Seeker @ ${payload.lat.toFixed(4)}, ${payload.lng.toFixed(4)} · no hider zone`);
      return;
    }
    const threshold = Number(g?.settings?.approachThresholdM) || 0;
    // prior: null — this path never tracks a crossing baseline of its own; it
    // only needs evaluateApproach for the distance number the pill shows.
    const { state } = evaluateApproach({ seekerPoint: this._lastSeekerPoint, zoneCentre: centre, thresholdM: threshold, prior: null });
    this._writePill(`Seeker ${formatDistance(state.distance)} from zone centre${threshold ? ` (alert < ${formatDistance(threshold)})` : ""}`);
  }

  // Phase 51: the server has already decided a seeker-close crossing happened
  // (against the zone _registerHiderZone told it about) and this device is
  // alive enough to receive the FCM message describing it. Reuses the exact
  // same _fireNotification path a foreground crossing would — same alert-style
  // read, same local-notify-vs-web-Notification choice — so the RESULT looks
  // identical no matter which side made the call.
  _onServerAlert({ title, body }) {
    if (!title) return;
    this._fireNotification({ kind: "seeker-close", title, body: body || "" });
  }

  _fireNotification(notify) {
    const { title, body } = notify;
    // Phase 33 (req #10): the shared "Off" also silences the seeker-close alert —
    // no system notification (seeker-close has no buzz/tone of its own). The pill
    // still updates in _onSeekerPing, so the hider can still see the distance.
    const alertStyle = store.getCurrent()?.settings?.geofenceAlertStyle || "vibrate-tone";
    if (alertStyle === "off") return;
    // Phase 44: on the Android shell, post a LOCAL notification — it shows from a
    // locked/backgrounded WebView (where the FCM message just woke us), which the
    // web Notification API can't. Off-device, fall through to the web path.
    if (this._postLocalNotify && this._isNative()) {
      Promise.resolve(this._postLocalNotify(notify, { alertStyle }))
        .catch((e) => console.warn("live-share: local notify failed", e));
      return;
    }
    if (!this.N || this.N.permission !== "granted") return;
    // Phase 17 (fix #5): SW-first with ack-or-page-fallback, same helper the
    // geofence uses. Guards against a stale SW during the upgrade window
    // silently swallowing the message.
    const firePage = () => {
      try { new this.N(title, { body, tag: SEEKER_CLOSE_TAG, renotify: true }); }
      catch (e) { console.warn("live-share notification failed", e); }
    };
    notifyViaSwOrPage({ type: "GEOFENCE_NOTIFY", title, body, tag: SEEKER_CLOSE_TAG }, firePage);
  }

  // Disconnecting stops the share; dismiss any seeker-close alert still in the
  // tray so it doesn't linger after the session ends (Phase 31.5 bug).
  stop() { this._teardown(); this._removePill(); this.role = null; this.code = null; clearNotification(SEEKER_CLOSE_TAG); }

  _teardown() {
    if (this._publishTimer) { clearInterval(this._publishTimer); this._publishTimer = null; }
    this._watchUnsub?.();
    this._watchUnsub = null;
    if (this._locationHandler) { try { this.transport?.off?.("location", this._locationHandler); } catch (_) {} this._locationHandler = null; }
    if (this._sessionErrorHandler) { try { this.transport?.off?.("session-error", this._sessionErrorHandler); } catch (_) {} this._sessionErrorHandler = null; }
    // Phase 44: drop the FCM data-message listener when the session ends.
    if (this._pushUnsub) { try { this._pushUnsub(); } catch (_) {} this._pushUnsub = null; }
    // Phase 51: stop pushing zone updates to the relay when the session ends.
    if (this._settingsUnsub) { try { this._settingsUnsub(); } catch (_) {} this._settingsUnsub = null; }
    // Phase 37: the session is ending — clear the red seeker dot. Only signal a
    // removal if there was a point to remove, so a plain re-start doesn't churn.
    if (this._lastSeekerPoint) { try { this.onSeekerPoint?.(null); } catch (e) { console.warn("onSeekerPoint threw", e); } }
    this._lastSeekerPoint = null;
    this.approachState = null;
    this._lastEmitAt = null;
  }

  _ensurePill() {
    if (this._pill) return;
    // Dismiss hides the pill only; the seeker's watch / hider's socket listener
    // keep running, so the close-approach alert still fires with the pill hidden.
    this._pill = createPill({ id: "live-share-pill", variant: "live-share" });
  }
  _removePill() { this._pill?.remove(); this._pill = null; }
  _writePill(text) { this._pill?.setText(text); }
}
