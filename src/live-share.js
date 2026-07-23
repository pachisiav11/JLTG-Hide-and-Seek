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
import { metresBetween } from "./geo.js";
import { createPill } from "./pill-stack.js";
import { geoWatch, GeoWatch } from "./geo-watch.js";
import { isNativeCapacitor } from "./bg-spike.js";

// Notification tag — shared with the SW so a stale seeker-close alert can be
// dismissed from the tray when sharing stops (Phase 31.5 bug).
const SEEKER_CLOSE_TAG = "jltg-seeker-close";

// Phase 24 (fix #12): compact distance formatter for the live-share pill.
//
// Under 1 km reads in metres (nearest metre). At 1 km and above, switch to km
// with up to two decimals — but strip trailing zeros so a round threshold
// like 2 km reads as "2 km", not "2.00 km" or (as it once did) "2000 m".
// parseFloat does the trailing-zero strip: parseFloat("1.00") === 1,
// parseFloat("2.50") === 2.5, parseFloat("1.23") === 1.23. Tested by
// test/game-live-share-format-distance.test.mjs on every option the UI
// offers plus the awkward-boundary cases.
export function formatDistance(m) {
  if (!Number.isFinite(m)) return "";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${parseFloat((m / 1000).toFixed(2))} km`;
}

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

// Pure decision function: given a seeker point + a hider's zone centre +
// threshold, decide whether a close-approach alert is due. Prior state carries
// last-inside status so we only fire on the "outside → inside" transition —
// once per crossing, not every 60 s while the seeker parks nearby (per user
// 2026-07-20).
//
// Two guard layers on the way in, kept separate on purpose. A missing point
// (`!seekerPoint || !zoneCentre`) is genuine "no signal" and returns a null-ish
// state — the caller has nothing to render. But a `thresholdM <= 0` picks the
// user-visible "Off (pin only)" mode from the live-share settings sheet: they
// still want the distance in the pill, just no crossing alert. Bundling those
// two guards used to null out the state either way, and `_onSeekerPing` then
// dereferenced `out.state.distance` on the first pin-only ping and threw.
export function evaluateApproach({ seekerPoint, zoneCentre, thresholdM, prior, now = Date.now() }) {
  if (!seekerPoint || !zoneCentre) return { state: prior || null, notify: null };
  const d = metresBetween(seekerPoint, zoneCentre);
  // Pin-only mode: return distance for the pill but never signal a crossing.
  if (!(thresholdM > 0)) return { state: { inside: false, distance: d, at: now }, notify: null };
  const inside = d < thresholdM;
  const wasInside = !!prior?.inside;
  const state = { inside, distance: d, at: now };
  if (inside && !wasInside) {
    return {
      state,
      notify: {
        kind: "seeker-close",
        title: "Seeker close",
        body: `A seeker is ~${formatDistance(d)} from your hiding zone centre.`,
      },
    };
  }
  return { state, notify: null };
}

// Session code generator — 6-char alphanumeric, human-readable, no ambiguous
// characters (0/O, 1/I/L). The two players exchange this out of band; the
// relay uses it as a room name.
export function generateSessionCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// Client wrapper. Transport is pluggable so tests can inject an in-memory
// event bus without opening a socket. Production callers construct a
// SocketIOTransport from the loaded socket.io-client global.
export class LiveShare {
  constructor({ transport, geolocation = (typeof navigator !== "undefined" ? navigator.geolocation : null), watch = null, bgWatch = null, isNative = isNativeCapacitor, Notification = (typeof window !== "undefined" ? window.Notification : null), onError = null, onSeekerPoint = null, emitIntervalMs = 60_000, now = () => Date.now() } = {}) {
    this.transport = transport;
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
  // most once per `emitIntervalMs` (default 60 s).
  //
  // Phase 23 (fix #11): switched from `setInterval` + `getCurrentPosition`
  // to `watchPosition` + client-side throttle. The old pattern woke the GPS
  // radio to a fresh fix every 60 s for a 45-minute game (heavy on Android
  // battery); watchPosition keeps a single subscription and rides whatever
  // fixes the device already produces, so the marginal cost of THIS feature
  // is close to zero when the geofence is also on (they share the GPS).
  // Emit cadence is capped by the throttle so the relay's rate limit
  // (Phase 19) is never approached and the hider's pill is not spammed.
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
    this._writePill(`Seeker ${formatDistance(d)} from zone${threshold ? ` (alert < ${formatDistance(threshold)})` : ""}`);
    if (out.notify) this._fireNotification(out.notify);
  }

  _fireNotification({ title, body }) {
    // Phase 33 (req #10): the shared "Off" also silences the seeker-close alert —
    // no system notification (seeker-close has no buzz/tone of its own). The pill
    // still updates in _onSeekerPing, so the hider can still see the distance.
    if (store.getCurrent()?.settings?.geofenceAlertStyle === "off") return;
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
