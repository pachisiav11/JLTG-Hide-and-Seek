// Phase 36 (req #7a): one shared geolocation watch.
//
// Three features want the device's own position — the hider geofence, the
// live-share seeker publisher, and the new blue self-dot — and each used to call
// navigator.geolocation.watchPosition itself. Three OS subscriptions wake the
// GPS radio three times over and triple the battery cost of "knowing where I am".
//
// GeoWatch is a ref-counted wrapper around ONE watchPosition: subscribers get
// every fix fanned out to them, and the OS watch is opened on the first
// subscribe and cleared on the last unsubscribe. A `lastFix` cache lets a late
// subscriber (e.g. the self-dot, mounted after the geofence) draw immediately
// from the last known position instead of waiting a full GPS cycle — but ONLY
// when it opts in via `replayLast`, so the seeker/geofence throttle-and-transition
// logic still sees only genuinely-new fixes.
//
// The app wires the exported `geoWatch` singleton into all three consumers so
// they share the subscription; tests build isolated GeoWatch instances around a
// mock geolocation.

const DEFAULT_OPTIONS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 };

export class GeoWatch {
  constructor({ geolocation = (typeof navigator !== "undefined" ? navigator.geolocation : null), options = DEFAULT_OPTIONS } = {}) {
    this.geo = geolocation;
    this.options = options;
    this._subs = new Set(); // each: { onFix, onError }
    this._watchId = null;
    this._lastFix = null;   // { lat, lng, accuracy, at }
  }

  get lastFix() { return this._lastFix; }
  get active() { return this._watchId != null; }
  get subscriberCount() { return this._subs.size; }

  // Subscribe to position fixes. `onFix(fix)` is called with each new fix;
  // `onError(err)` (optional) with each GPS error. Returns an unsubscribe fn.
  // With `replayLast: true`, a cached last fix is delivered synchronously on
  // subscribe so a fresh consumer can draw at once.
  subscribe(onFix, onError = null, { replayLast = false } = {}) {
    const sub = { onFix, onError };
    this._subs.add(sub);
    if (replayLast && this._lastFix && typeof onFix === "function") {
      try { onFix(this._lastFix); } catch (e) { console.warn("geo-watch replay threw", e); }
    }
    this._ensureWatch();
    return () => this._unsubscribe(sub);
  }

  _unsubscribe(sub) {
    if (!this._subs.delete(sub)) return;
    if (this._subs.size === 0) this._stopWatch();
  }

  _ensureWatch() {
    if (this._watchId != null || !this.geo?.watchPosition) return;
    this._watchId = this.geo.watchPosition(
      (p) => this._onPosition(p),
      (err) => this._onError(err),
      this.options,
    );
  }

  _stopWatch() {
    if (this._watchId != null && this.geo?.clearWatch) {
      try { this.geo.clearWatch(this._watchId); } catch (_) { /* already gone */ }
    }
    this._watchId = null;
  }

  _onPosition(p) {
    const c = p?.coords || {};
    const fix = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, at: p?.timestamp || Date.now() };
    this._lastFix = fix;
    // Snapshot the set so a subscriber that unsubscribes from inside its own
    // handler doesn't mutate the set mid-iteration.
    for (const sub of [...this._subs]) {
      try { sub.onFix?.(fix); } catch (e) { console.warn("geo-watch subscriber threw", e); }
    }
  }

  _onError(err) {
    for (const sub of [...this._subs]) {
      try { sub.onError?.(err); } catch (e) { console.warn("geo-watch error handler threw", e); }
    }
  }
}

// App-wide shared instance — the one OS watch all three consumers ride.
export const geoWatch = new GeoWatch();
