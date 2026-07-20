// Phase 3 (A1) — hider-side geofence for the hiding zone.
//
// PLAYTEST_2026-07-19 recorded two systemic pains from the first real-world game. The
// first was "hiders can't tell if they're inside the hiding zone" — nobody checks a
// map every minute during a 45-minute hide, so drifting toward the edge (or across it)
// goes unnoticed until the seekers close in. Reactive tools cannot catch that: the app
// has to speak up on its own.
//
// This module is that speaker. When enabled from Settings, it watches
// `navigator.geolocation.watchPosition` against the current game's focus zone (§ per
// user 2026-07-20: the Hider tool doubles as the hiding zone) and fires notifications
// at two moments the hider cares about:
//
//   - APPROACHING the edge from inside:  "80 m from zone edge — turn back."
//   - CROSSING the edge:                 "You've left the zone — return."
//
// The threshold is user-configurable; 0 disables the whole feature. The check itself
// is cheap (a haversine per GPS tick), so the cost is just the geolocation subscription
// and any battery it draws.
//
// Honest scope: works reliably only while the app is foregrounded (a background PWA on
// mobile is throttled or evicted). The Notifications API + a foreground pill is what
// this ships with; true background tracking is a TWA/native concern documented in
// PLAYTEST_IDEAS.md A1 and NOT taken on here.
//
// The pill is a persistent DOM element showing live distance to the edge, so a hider
// who does happen to glance at the app sees it without needing a permission-gated
// notification. That is the always-visible companion to the once-per-crossing alert.

import * as store from "./store.js";

// Two thresholds are used from the settings value N (metres):
//   - Fire NEAR-EDGE alert when distance to edge < N and inside the zone.
//   - Fire OUTSIDE alert when the hider has crossed the boundary.
// A single crossing must fire at most one notification per side (a hider standing on
// the line would otherwise get spammed). `state.lastEdgeFire` tracks time; a
// crossing-side change also resets the debounce so an out-then-back-in sequence
// re-alerts properly.
const MIN_RE_ALERT_MS = 60_000;

function metresBetween(a, b) {
  const R = 6371000;
  const lat0 = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI / 180) * Math.cos(lat0);
  return R * Math.hypot(dLat, dLng);
}

// Given the hider's position and the focus zone, decide whether to fire and (if the
// caller keeps a persistent pill) what to write in it. Pure — takes state in, returns
// the next state and any `notify` payload the caller should surface.
//
// Returned `notify` is null (nothing to say) or `{kind, title, body}`. The caller
// composes that into a Notification and/or a foreground pill; this module does not
// touch the DOM so it can be tested in Node.
export function evaluateGeofence({ position, zone, thresholdMetres, prior, now = Date.now() }) {
  const out = { state: prior, notify: null, pill: null };
  if (!zone?.point || !zone.radius || !(thresholdMetres > 0) || !position) return out;
  const dCentre = metresBetween(position, zone.point);
  const dEdge = Math.abs(dCentre - zone.radius); // distance to the nearest point on the edge
  const inside = dCentre <= zone.radius;
  const nextState = { ...(prior || {}), inside, lastEdge: dEdge, lastCentre: dCentre };

  // Pill text: always available while the feature is enabled.
  out.pill = inside
    ? `In zone · ${Math.round(dEdge)} m from edge`
    : `OUT of zone · ${Math.round(dEdge)} m over the edge`;

  // A crossing from inside → outside always wins over an approaching alert on the
  // same tick, because "you left" is what a hider hears first once they've stepped
  // across. Debounce keys are separate so a re-entry then re-exit alerts each time.
  const crossedOut = prior?.inside === true && !inside;
  const crossedIn = prior?.inside === false && inside;

  const dueBySide = prior?.notify?.side !== (inside ? "in" : "out")
    || !prior?.notify?.at
    || (now - prior.notify.at) > MIN_RE_ALERT_MS;

  if (crossedOut) {
    out.notify = { kind: "crossed-out", title: "You've left the hiding zone", body: `${Math.round(dEdge)} m past the edge — return to the zone.` };
    nextState.notify = { side: "out", at: now, reason: "crossed" };
  } else if (!inside && dueBySide) {
    // Still outside, and we haven't recently said so — nudge again after the debounce.
    out.notify = { kind: "still-out", title: "Still outside the hiding zone", body: `${Math.round(dEdge)} m past the edge.` };
    nextState.notify = { side: "out", at: now, reason: "still" };
  } else if (crossedIn) {
    out.notify = { kind: "back-in", title: "Back inside the hiding zone", body: `Safe — ${Math.round(dEdge)} m from the edge.` };
    nextState.notify = { side: "in", at: now, reason: "crossed" };
  } else if (inside && dEdge < thresholdMetres && dueBySide) {
    out.notify = { kind: "approaching", title: "Near the hiding zone edge", body: `${Math.round(dEdge)} m from the edge — turn back.` };
    nextState.notify = { side: "in", at: now, reason: "near" };
  }

  out.state = nextState;
  return out;
}

// Live geofence watcher for the app. Manages the geolocation subscription, the
// notification firing, the foreground pill, and cleanup on toggle-off / game-change.
export class Geofence {
  constructor({ Notification = (typeof window !== "undefined" ? window.Notification : null), geolocation = (typeof navigator !== "undefined" ? navigator.geolocation : null) } = {}) {
    this.N = Notification;
    this.geo = geolocation;
    this.watchId = null;
    this.state = null;
    this.pillEl = null;
    this._unsub = null;
    this._settingsThreshold = 0;
  }

  // Read the settings threshold from the current game. 0 means disabled.
  _threshold() {
    const g = store.getCurrent();
    return Number(g?.settings?.geofenceMetres) || 0;
  }

  // Start / stop / restart from settings. Called at boot AND whenever the setting
  // toggles or a new game loads (store subscription).
  init() {
    this._unsub = store.subscribe(() => this._reconcile());
    this._reconcile();
  }
  destroy() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this._stopWatch();
    this._removePill();
  }

  async _reconcile() {
    const threshold = this._threshold();
    const g = store.getCurrent();
    const hasZone = !!(g?.focusZone?.point && g?.focusZone?.radius);
    if (!threshold || !hasZone) { this._stopWatch(); this._removePill(); this.state = null; return; }
    // Request Notifications permission on FIRST enable, once. Denial doesn't disable
    // the feature — the pill still updates; the alerts just don't leave the tab.
    if (this.N && this.N.permission === "default") {
      try { await this.N.requestPermission(); } catch { /* user closed the prompt */ }
    }
    this._startWatch();
    this._ensurePill();
  }

  _startWatch() {
    if (this.watchId != null || !this.geo?.watchPosition) return;
    this.watchId = this.geo.watchPosition(
      (pos) => this._onPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => { console.warn("geofence: geolocation error", err); this._writePill("Location unavailable"); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
    );
  }
  _stopWatch() {
    if (this.watchId != null && this.geo?.clearWatch) this.geo.clearWatch(this.watchId);
    this.watchId = null;
  }

  _onPosition(position) {
    const g = store.getCurrent();
    const zone = g?.focusZone;
    const threshold = this._threshold();
    const { state, notify, pill } = evaluateGeofence({ position, zone, thresholdMetres: threshold, prior: this.state });
    this.state = state;
    if (pill) this._writePill(pill);
    if (notify) this._fireNotification(notify);
  }

  _fireNotification({ title, body }) {
    if (!this.N || this.N.permission !== "granted") return;
    try { new this.N(title, { body, tag: "jltg-geofence", renotify: true, silent: false }); }
    catch (e) { console.warn("geofence: notification failed", e); }
  }

  _ensurePill() {
    if (this.pillEl) return;
    if (typeof document === "undefined") return;
    const el = document.createElement("div");
    el.id = "geofence-pill";
    el.className = "geofence-pill";
    el.textContent = "Locating…";
    document.body.appendChild(el);
    this.pillEl = el;
  }
  _removePill() {
    this.pillEl?.remove();
    this.pillEl = null;
  }
  _writePill(text) {
    if (!this.pillEl) return;
    this.pillEl.textContent = text;
    this.pillEl.classList.toggle("geofence-warn", /^OUT|Still|Near|left|edge/.test(text));
  }
}
