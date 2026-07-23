// Phase 42 (Stage 6, Track B 1/3): the seeker's BACKGROUND location stream.
//
// The seeker-close alert has a different shape from the hider geofence (Track A).
// There, the moving thing is the hider, whose phone we let sleep — the OS/edge
// maths runs on-device. Here the moving thing is the SEEKER, and the hider's
// phone must learn where the seeker is even while the seeker's phone is locked in
// a pocket. So the seeker's phone is the one we must keep awake: it streams GPS to
// the Render relay continuously, and the relay forwards each ping to the hider
// (Phases 43–44 add the FCM last hop; the socket path already works foreground).
//
// The web seeker (src/live-share.js `startAsSeeker`) rides the shared foreground
// GeoWatch — which dies when the phone locks. This module is the background
// substitute: a GeoWatch-COMPATIBLE adapter around the same
// @capacitor-community/background-geolocation foreground service the Phase 40
// spike proved Doze-proof. Because it exposes the exact GeoWatch surface
// (subscribe/active/lastFix/onActiveChange, fixes shaped {lat,lng,accuracy,at}),
// LiveShare's throttle-and-emit logic (Phase 23) rides it UNCHANGED — the only
// wiring change is *which* watch the seeker subscribes to when in the native
// shell. The plugin's persistent "sharing your location" foreground-service
// notification doubles as the seeker's req-#5 "location in use" indicator.
//
// Inert off-device: without the native shell nothing here opens a watcher, so the
// web seeker path is untouched. The pure options helper is unit-tested; the
// ref-counted watcher needs the phone (its contract is pinned via a fake plugin).

import { normalizeLocation, isNativeCapacitor } from "./bg-spike.js";

// Options for the seeker's background-location foreground service. A small
// distanceFilter keeps the radio quiet while the seeker is stationary (no point
// re-sending an unchanged position); LiveShare's own 60 s throttle (Phase 23)
// still caps the OUTBOUND cadence so the relay's rate limit (Phase 19) is never
// approached even when the seeker is moving fast and the plugin reports often.
export function seekerWatcherOptions() {
  return {
    backgroundMessage: "Sharing your location with the hider so they get close-range alerts.",
    backgroundTitle: "JLTG is sharing your location",
    requestPermissions: true,
    stale: false,
    distanceFilter: 10,
  };
}

// A GeoWatch-compatible watcher backed by the background-location foreground
// service. Same public surface as src/geo-watch.js so LiveShare can ride either.
export class NativeSeekerWatch {
  constructor({ isNative = isNativeCapacitor, plugins = null } = {}) {
    this._isNative = isNative;
    this.BG = plugins?.BG || null;
    this._pluginsInjected = !!plugins;
    this._pluginsReady = null;
    this._subs = new Set();          // each: { onFix, onError }
    this._watcherId = null;
    this._wantActive = false;        // intent, decoupled from the async watcherId
    this._lastFix = null;
    this._activeListeners = new Set();
  }

  get active() { return this._watcherId != null; }
  get lastFix() { return this._lastFix; }
  get subscriberCount() { return this._subs.size; }

  // True only when we can actually stream in the background — i.e. inside the
  // native shell. LiveShare consults this to decide whether to prefer this watch
  // over the foreground GeoWatch.
  get available() { return !!this._isNative(); }

  onActiveChange(fn) {
    this._activeListeners.add(fn);
    try { fn(this.active); } catch (e) { console.warn("native-seeker: active listener threw", e); }
    return () => this._activeListeners.delete(fn);
  }
  _emitActive() {
    for (const fn of [...this._activeListeners]) {
      try { fn(this.active); } catch (e) { console.warn("native-seeker: active listener threw", e); }
    }
  }

  subscribe(onFix, onError = null, { replayLast = false } = {}) {
    const sub = { onFix, onError };
    this._subs.add(sub);
    if (replayLast && this._lastFix && typeof onFix === "function") {
      try { onFix(this._lastFix); } catch (e) { console.warn("native-seeker: replay threw", e); }
    }
    this._ensureWatch();
    return () => this._unsubscribe(sub);
  }

  _unsubscribe(sub) {
    if (!this._subs.delete(sub)) return;
    if (this._subs.size === 0) this._stopWatch();
  }

  async _ensurePlugins() {
    if (this.BG) return;
    if (this._pluginsInjected) return;
    if (!this._pluginsReady) {
      this._pluginsReady = import("../vendor/capacitor-core.js").then(({ registerPlugin }) => {
        this.BG = registerPlugin("BackgroundGeolocation");
      });
    }
    await this._pluginsReady;
  }

  async _ensureWatch() {
    if (this._wantActive) return;
    this._wantActive = true;
    await this._ensurePlugins();
    // Unsubscribed while the plugin loaded, or already running — bail.
    if (!this._wantActive || !this.BG || this._watcherId != null) return;
    try {
      const id = await this.BG.addWatcher(seekerWatcherOptions(), (location, error) => {
        if (error) { this._onError(error); return; }
        this._onFix(location);
      });
      // A last-unsubscribe raced ahead of addWatcher resolving — tear the fresh
      // watcher straight back down so we don't leak a foreground service.
      if (!this._wantActive) { try { await this.BG.removeWatcher({ id }); } catch { /* gone */ } return; }
      this._watcherId = id;
      this._emitActive();
    } catch (e) {
      console.warn("native-seeker: addWatcher failed", e);
    }
  }

  _stopWatch() {
    this._wantActive = false;
    const id = this._watcherId;
    if (id == null) return;
    this._watcherId = null;
    try { this.BG?.removeWatcher?.({ id })?.catch?.(() => {}); } catch { /* gone */ }
    this._emitActive();
  }

  _onFix(location) {
    const fix = normalizeLocation(location);
    if (!fix) return;
    this._lastFix = fix; // already {lat,lng,accuracy,at}
    for (const sub of [...this._subs]) {
      try { sub.onFix?.(fix); } catch (e) { console.warn("native-seeker: subscriber threw", e); }
    }
  }

  _onError(err) {
    for (const sub of [...this._subs]) {
      try { sub.onError?.(err); } catch (e) { console.warn("native-seeker: error handler threw", e); }
    }
  }
}
