// Phase 41 (Stage 6, Track A): the hider's BACKGROUND geofence on Android.
//
// This is the first real payoff of the whole native track. The web geofence
// (src/geofence.js) only fires while the app is foregrounded — a PWA's GPS watch
// is throttled or evicted the moment the phone locks, which is exactly when a
// hider pockets the phone for a 45-minute hide. Phase 40's on-device Doze spike
// answered the gating question (docs/PHASE40_RESULTS.md): the free
// @capacitor-community/background-geolocation FOREGROUND SERVICE keeps delivering
// fixes straight through Doze on the target OEM (max inter-fix gap 7.5 s off the
// whitelist). So the decision was:
//
//   PASS → the hider geofence RIDES that foreground service. Compute the band in
//   JS with the SAME evaluateGeofence the web path uses, and fire the alert as a
//   @capacitor/local-notifications local notification. No native OS geofencing,
//   no FCM — those were the fallback the spike retired.
//
// So this module is a thin, headless-testable bridge with one job: while a hider
// zone + threshold exist, keep the background-location foreground service open
// and, on every background fix, run the Phase 32 band machine and post a local
// notification on each transition — honouring the Phase 33 "Off" setting. The
// band semantics, the notify copy, and the "when do we alert" contract all live
// in geofence.js; this module only carries them to a locked phone.
//
// It is INERT off-device: `isNativeCapacitor()` is false in a browser/PWA and in
// node, so nothing here opens a watcher or touches a plugin unless we are inside
// the Capacitor Android shell. The pure helpers below (wants/options/mapping) are
// exported and unit-tested; only `start()`/`_onFix()` need the phone.

import { evaluateGeofence } from "./geofence.js";
import { normalizeLocation, isNativeCapacitor } from "./bg-spike.js";
import * as storeModule from "./store.js";

// LocalNotification ids must be distinct 32-bit ints; keep the geofence alerts in
// their own high band so they never collide with the spike's (1000+) ids.
const NOTIFY_ID_BASE = 2000;

// Android notification channels carry the sound/vibration policy. We name two so
// the Phase 33 "silent" style maps to a channel with importance LOW (no buzz, no
// tone) while the normal style uses the default alerting channel. The channels
// themselves are created in the native layer (documented manual half); this JS
// only *selects* the channel, which is the part worth pinning in a test.
export const CHANNEL_ALERT = "jltg-geofence";
export const CHANNEL_SILENT = "jltg-geofence-silent";

// --- Pure helpers (headless-testable; no DOM, no Capacitor) ----------------

// Should the background geofence be running for this game? Same gate as the web
// path (src/geofence.js `_reconcile`): a placed hider zone (point + radius) AND a
// non-zero edge threshold. Marker-only zones (no radius) and threshold 0 disable
// it, exactly as evaluateGeofence itself no-ops on them.
export function wantsNativeGeofence(game) {
  const z = game?.focusZone;
  const threshold = Number(game?.settings?.geofenceMetres) || 0;
  return !!(z?.point && z.radius && threshold > 0);
}

// A stable signature of the zone+threshold currently being watched. When it
// changes (the hider re-places the zone or edits the threshold), the band
// baseline must reset so the next fix re-establishes "safe/near/out" silently
// rather than firing a spurious transition against the old geometry.
export function zoneKey(game) {
  const z = game?.focusZone;
  if (!wantsNativeGeofence(game)) return null;
  const threshold = Number(game?.settings?.geofenceMetres) || 0;
  return `${z.point.lat.toFixed(6)},${z.point.lng.toFixed(6)}|${z.radius}|${threshold}`;
}

// Options for the community plugin's addWatcher. distanceFilter 0 = report every
// fix (we want the band checked on cadence, not only after N metres of motion —
// a hider drifting slowly toward the edge still needs the "approaching" alert).
// requestPermissions walks the user through "Allow all the time"; the persistent
// foreground-service notification is what keeps the process alive in Doze.
export function backgroundWatcherOptions() {
  return {
    backgroundMessage: "Watching the hiding-zone edge so you get an alert even with the screen off.",
    backgroundTitle: "JLTG · hiding-zone alerts on",
    requestPermissions: true,
    stale: false,
    distanceFilter: 0,
  };
}

// Map an evaluateGeofence `notify` ({kind,title,body}) + the game's alert style to
// a LocalNotifications notification object — or null when the feature is "Off".
//
// This folds the Phase 33 cross-cutting contract into one tested place: "off"
// suppresses the notification entirely (the native side never posts, so nothing
// buzzes or lands in the tray), while "silent" routes to the LOW-importance
// channel (posts quietly, no buzz/tone) and every other style uses the alerting
// channel. `schedule` is added by the caller (it carries a live Date), so this
// stays deterministic to unit-test.
export function localNotificationForNotify(notify, id, alertStyle = "vibrate-tone") {
  if (!notify || alertStyle === "off") return null;
  const silent = alertStyle === "silent";
  return {
    id,
    title: notify.title,
    body: notify.body || "",
    channelId: silent ? CHANNEL_SILENT : CHANNEL_ALERT,
    // Tag-like grouping so a fresh crossing replaces the previous tray entry
    // rather than stacking (mirrors the web path's fixed geofence tag).
    group: CHANNEL_ALERT,
    ongoing: false,
  };
}

// --- The on-device bridge (needs the native shell) -------------------------

export class NativeGeofence {
  // Dependency-injected so a headless test can drive fixes through a fake plugin
  // and assert on scheduled notifications without a phone. Production defaults to
  // the real store, the real native check, and lazily-loaded Capacitor plugins.
  constructor({ store = storeModule, isNative = isNativeCapacitor, plugins = null } = {}) {
    this.store = store;
    this._isNative = isNative;
    this.BG = plugins?.BG || null;
    this.LN = plugins?.LN || null;
    this._pluginsInjected = !!plugins;
    this._pluginsReady = null;
    this.state = null;         // evaluateGeofence prior band state
    this.watcherId = null;
    this.notifyId = NOTIFY_ID_BASE;
    this.liveIds = new Set();  // posted notification ids, so we can cancel on stop
    this._activeKey = null;    // zoneKey currently watched
    this._unsub = null;
  }

  get watching() { return this.watcherId != null; }

  // Subscribe to the store and reconcile now. A no-op off-device: without the
  // native shell there is no foreground service to ride, so the web geofence
  // (src/geofence.js) remains the only alerter, exactly as before this phase.
  init() {
    if (!this._isNative()) return;
    this._unsub = this.store.subscribe(() => { this._reconcile(); });
    this._reconcile();
  }

  async destroy() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    await this.stop();
  }

  async _ensurePlugins() {
    if (this.BG && this.LN) return;
    if (this._pluginsInjected) return; // tests provide both up front
    if (!this._pluginsReady) {
      this._pluginsReady = import("../vendor/capacitor-core.js").then(({ registerPlugin }) => {
        this.BG = registerPlugin("BackgroundGeolocation");
        this.LN = registerPlugin("LocalNotifications");
      });
    }
    await this._pluginsReady;
  }

  _reconcile() {
    const g = this.store.getCurrent();
    const key = zoneKey(g);
    if (!key) { this.stop(); return; }
    if (this.watching && key === this._activeKey) return; // unchanged — leave the service running
    // A new or edited zone: reset the band baseline so the next fix establishes
    // it silently instead of firing a transition against the old geometry.
    this.state = null;
    this._activeKey = key;
    this.start();
  }

  async start() {
    if (this.watching) return;
    await this._ensurePlugins();
    if (!this.BG) return;
    try {
      this.watcherId = await this.BG.addWatcher(backgroundWatcherOptions(), (location, error) => {
        if (error) { console.warn("native-geofence: watcher error", error); return; }
        this._onFix(location);
      });
      // Make sure a background tick can actually post a notification.
      try { await this.LN?.requestPermissions?.(); } catch { /* denied → _fire no-ops */ }
    } catch (e) {
      console.warn("native-geofence: addWatcher failed", e);
      this.watcherId = null;
    }
  }

  async stop() {
    if (!this.watching) {
      // Even if the watcher is already down, clear any posted alert so a stale
      // "left the zone" doesn't sit on the lock screen after the zone is removed
      // (the native mirror of the Phase 31.5 web fix).
      await this._cancelPosted();
      return;
    }
    const id = this.watcherId;
    this.watcherId = null;
    this._activeKey = null;
    this.state = null;
    try { await this.BG?.removeWatcher?.({ id }); } catch { /* already gone */ }
    await this._cancelPosted();
  }

  // Called on every background fix from the foreground-service watcher. Runs the
  // exact Phase 32 band machine against the current zone and fires on a change.
  _onFix(location) {
    const fix = normalizeLocation(location);
    if (!fix) return;
    const g = this.store.getCurrent();
    const zone = g?.focusZone;
    const threshold = Number(g?.settings?.geofenceMetres) || 0;
    const { state, notify } = evaluateGeofence({
      position: { lat: fix.lat, lng: fix.lng },
      zone,
      thresholdMetres: threshold,
      prior: this.state,
    });
    this.state = state;
    if (notify) this._fire(notify);
  }

  _fire(notify) {
    const style = this.store.getCurrent()?.settings?.geofenceAlertStyle || "vibrate-tone";
    const id = ++this.notifyId;
    const payload = localNotificationForNotify(notify, id, style);
    if (!payload) return; // "Off" — suppress entirely (Phase 33).
    try {
      this.LN?.schedule?.({
        notifications: [{ ...payload, schedule: { at: new Date(Date.now() + 50) } }],
      });
      this.liveIds.add(id);
    } catch (e) {
      console.warn("native-geofence: notify failed", e);
    }
  }

  async _cancelPosted() {
    if (!this.liveIds.size) return;
    const notifications = [...this.liveIds].map((id) => ({ id }));
    this.liveIds.clear();
    try { await this.LN?.cancel?.({ notifications }); } catch { /* nothing posted / plugin gone */ }
  }
}
