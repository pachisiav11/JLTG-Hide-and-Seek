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
// path (src/geofence.js `_reconcile`): a placed hider zone (point + radius), a
// non-zero edge threshold, AND this device's user playing Hider — a seeker's
// Hider-zone is just their guess, not a zone they themselves must stay inside.
// Marker-only zones (no radius) and threshold 0 disable it too, exactly as
// evaluateGeofence itself no-ops on them. Role defaults to "seeker" (model.js).
export function wantsNativeGeofence(game) {
  const z = game?.focusZone;
  const threshold = Number(game?.settings?.geofenceMetres) || 0;
  const role = game?.settings?.role || "seeker";
  return !!(z?.point && z.radius && threshold > 0 && role === "hider");
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
  constructor({ store = storeModule, isNative = isNativeCapacitor, plugins = null, onError = () => {}, ensureChannels = null } = {}) {
    this.store = store;
    this._isNative = isNative;
    this.BG = plugins?.BG || null;
    this.LN = plugins?.LN || null;
    this._pluginsInjected = !!plugins;
    this._pluginsReady = null;
    this.onError = onError;    // surfaces fatal start/notify failures (app.js wires this to toast())
    this.state = null;         // evaluateGeofence prior band state
    this.watcherId = null;
    this._starting = false;    // guards against a second addWatcher while one is still in flight
    this.notifyId = NOTIFY_ID_BASE;
    this.liveIds = new Set();  // posted notification ids, so we can cancel on stop
    this._activeKey = null;    // zoneKey currently watched
    this._unsub = null;
    // Test override; null in production, where start() dynamically imports the
    // real ensureNotificationChannels() (see native-channels.js — a channel id
    // Android never created gets a post silently dropped, no error anywhere).
    this._ensureChannels = ensureChannels;
    // Optimistic default so _fire() behaves exactly as before until start()'s
    // real check resolves (or on the very first fix, if it hasn't yet).
    this._channelsReady = true;
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
    // _reconcile is sync and start() is not awaited here (a store subscriber
    // can't be async) — start() already catches everything internally, but
    // .catch is belt-and-braces against an unhandled rejection escaping it.
    this.start().catch(() => {});
  }

  async start() {
    if (this.watching || this._starting) return;
    this._starting = true;
    try {
      await this._ensurePlugins();
      if (!this.BG) return;
      // Make sure the channels every alert selects by id actually exist before
      // arming the watcher — see native-channels.js for why boot-time creation
      // could silently never land. _fire() falls back to no channelId (the
      // plugin's own default channel) when this comes back false.
      try {
        this._channelsReady = this._ensureChannels
          ? await this._ensureChannels()
          : await import("./native-channels.js").then((m) => m.ensureNotificationChannels({ isNative: this._isNative }));
      } catch {
        this._channelsReady = false;
      }
      // Request the notification permission BEFORE opening the watcher, and wait
      // for it to fully resolve first. addWatcher's own requestPermissions:true
      // option pops the location dialog; firing LocalNotifications.requestPermissions()
      // concurrently with that (as this used to, right after addWatcher) risks two
      // overlapping Android permission dialogs — the second one commonly comes back
      // auto-denied with no prompt at all, permanently losing that grant for the
      // session with no error anywhere.
      try {
        const perm = await this.LN?.checkPermissions?.();
        if (perm?.display !== "granted") await this.LN?.requestPermissions?.();
      } catch { /* denied — _fire's schedule() call will surface it when it actually tries to post */ }
      this.watcherId = await this.BG.addWatcher(backgroundWatcherOptions(), (location, error) => {
        if (error) {
          // Capacitor's callback-return bridge resolves addWatcher()'s PROMISE as
          // soon as the native call registers a callback id — a native call.reject
          // (permission denied, location services off, the plugin's service not yet
          // bound) never rejects that promise; it arrives HERE instead, as the
          // callback's error argument. Previously this only console.warn'd and left
          // watcherId set, so `watching` stayed true and _reconcile's `if (this.watching
          // && key === this._activeKey) return;` guard skipped retrying forever — the
          // single most likely explanation for "toggled it on, nothing ever fired,
          // still nothing after reopening the app". Clearing the watch state here lets
          // the next store change (or a later _reconcile) start a fresh watcher instead
          // of believing a dead one is still running.
          console.warn("native-geofence: watcher error", error);
          this.watcherId = null;
          this._activeKey = null;
          this.onError(`Hiding-zone background alerts stopped: ${error?.message || error?.code || "location error"}.`);
          return;
        }
        this._onFix(location);
      });
    } catch (e) {
      console.warn("native-geofence: start failed", e);
      this.watcherId = null;
      this._pluginsReady = null; // don't keep replaying a cached rejection — let a retry re-import
      this.onError("Hiding-zone background alerts failed to start.");
    } finally {
      this._starting = false;
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
    // Channels not confirmed ready (creation failed, or hasn't resolved yet) —
    // fall back to the plugin's own default channel rather than posting to an
    // id that doesn't exist, which Android drops with total silence.
    if (!this._channelsReady) delete payload.channelId;
    this.liveIds.add(id);
    // No `schedule.at`: the plugin posts immediately via notify() when `schedule`
    // is omitted. A future `at` — even the ~50ms this used to pass — instead
    // routes through AlarmManager (inexact/non-wakeup without SCHEDULE_EXACT_ALARM,
    // which this app doesn't request) AND is silently dropped outright if the
    // native side processes the call after that instant has already passed,
    // which a slow bridge hop can do. Immediate delivery has neither failure mode.
    //
    // schedule() returning a promise was previously fire-and-forgotten: a reject
    // (e.g. "Notifications not enabled on this device" when POST_NOTIFICATIONS
    // is off) became an unhandled rejection — silent everywhere. Catching it here
    // is the only way a denied notification permission ever becomes visible.
    Promise.resolve(this.LN?.schedule?.({ notifications: [payload] }))
      .catch((e) => {
        console.warn("native-geofence: notify failed", e);
        this.onError("Hiding-zone alert couldn't be shown — check the app's notification permission.");
      });
  }

  async _cancelPosted() {
    if (!this.liveIds.size) return;
    const notifications = [...this.liveIds].map((id) => ({ id }));
    this.liveIds.clear();
    try { await this.LN?.cancel?.({ notifications }); } catch { /* nothing posted / plugin gone */ }
  }
}

// A user-triggered "prove it works right now" tap — schedules ONE real
// notification through the exact same channel/schedule-free path _fire() uses,
// so a single button press confirms (or names) the failure end-to-end: channel
// creation, the POST_NOTIFICATIONS grant, and the plugin's schedule() call.
// Everything upstream of this (a placed zone, a crossed band) takes minutes to
// re-trigger on a real walk; this answers "will an alert reach me at all" in
// one tap. Native-only; `plugins.LN` injectable for tests.
export async function postTestNotification({ plugins = null, isNative = isNativeCapacitor, ensureChannels = null } = {}) {
  if (!isNative()) return { ok: false, reason: "Not running in the Android app." };
  let LN = plugins?.LN;
  if (!LN) {
    try {
      const mod = await import("../vendor/capacitor-core.js");
      LN = mod.registerPlugin("LocalNotifications");
    } catch (e) {
      return { ok: false, reason: e?.message || String(e) };
    }
  }
  // A test's whole purpose is revealing exactly this kind of problem, so unlike
  // _fire()'s silent channelId-stripping fallback, be honest here: if the
  // channels this alert would post to were never actually created (see
  // native-channels.js), say so instead of reporting a false "sent".
  // `ensureChannels` is a test override; production always does the real
  // check when no `plugins` were injected (tests inject their own LN and skip
  // it, matching how the rest of this module tests plugin-level behaviour).
  const checkChannels = ensureChannels || (plugins ? null : () => import("./native-channels.js").then((m) => m.ensureNotificationChannels({ isNative })).catch(() => false));
  if (checkChannels) {
    const ready = await checkChannels();
    if (!ready) return { ok: false, reason: "Notification channels aren't set up yet — close and reopen the app, then try again." };
  }
  // schedule() below does NOT reject when POST_NOTIFICATIONS is denied — it
  // resolves fine and posts nothing, which is exactly the "test says it worked
  // but nothing showed" report this button exists to catch. Checking (and, if
  // never decided, requesting) the grant FIRST turns that silent failure into
  // an honest, actionable reason. If Android already auto-denied it once
  // in-app, requestPermissions() won't reprompt — only Settings can fix it,
  // hence the explicit pointer there rather than "try again".
  try {
    const perm = await LN.checkPermissions?.();
    let display = perm?.display;
    if (display !== "granted") {
      const req = await LN.requestPermissions?.();
      display = req?.display;
    }
    if (display && display !== "granted") {
      return { ok: false, reason: "Notifications are off for this app. Enable them in Android Settings → Apps → JLTG → Notifications, then try again." };
    }
  } catch { /* couldn't check — fall through and let schedule() itself be the signal */ }
  // Always audible/visible regardless of the current alert style — a test tap
  // is meaningless if "Off" makes it suppress itself like a real alert would.
  const payload = localNotificationForNotify(
    { kind: "test", title: "Test alert", body: "If you can see this, hiding-zone alerts will reach you." },
    NOTIFY_ID_BASE - 1,
    "vibrate-tone",
  );
  try {
    await LN.schedule({ notifications: [payload] });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}
