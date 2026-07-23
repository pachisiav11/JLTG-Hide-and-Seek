# Phase 41 — hider background geofence (Track A)

**Status:** code + headless tests committed (`src/native-geofence.js`,
`test/native-geofence.test.mjs`, 10 tests). The **device half is manual** — an
APK build + a locked-pocket walk — because a background alert through Doze can
only be proven on a phone. Phase 40 already proved the underlying mechanism on
this OEM (`docs/PHASE40_RESULTS.md`); this phase builds the real hider flow on it.

## What this phase does

The web geofence (`src/geofence.js`) only fires while the app is foregrounded — a
PWA's GPS watch dies when the phone locks, which is exactly when a hider pockets
it. Phase 40's spike showed the free `@capacitor-community/background-geolocation`
**foreground service** keeps delivering fixes through Doze (max gap 7.5 s off the
Doze whitelist). So the hider geofence now **rides that service**:

- While a hider zone (`focusZone.point` + `radius`) and a non-zero edge threshold
  (`settings.geofenceMetres`) exist, `NativeGeofence` keeps the background watcher
  open (persistent foreground-service notification).
- On **every background fix** it runs the **same `evaluateGeofence`** band machine
  the web path uses (Phase 32 semantics: one alert per `safe`/`near`/`out`
  transition, silent while parked) and posts a **`@capacitor/local-notifications`**
  local notification on each crossing.
- It honours the Phase 33 alert style: **Off** suppresses the notification
  entirely; **silent** routes to a LOW-importance channel (no buzz/tone).
- Re-placing the zone resets the band baseline; removing the zone stops the
  watcher and cancels any alert still on the tray (native mirror of Phase 31.5).

Off-device (`isNativeCapacitor()` false in a browser/PWA/node) the whole module is
inert and the foreground `Geofence` remains the sole alerter. Inside the shell,
`Geofence` keeps its always-visible **pill** but defers **alerts** to
`NativeGeofence`, so a crossing is never double-notified.

## Manual half — build & device QA

### 1. Manifest permissions (now permanent, not spike-only)

These are the same permissions the Phase 40 spike listed
(`docs/PHASE40_DOZE_SPIKE.md`), but they are now a **shipped requirement**, not a
one-off. `android/` is generated and git-ignored, so after `npx cap add android`
/ `npx cap sync`, confirm `android/app/src/main/AndroidManifest.xml` contains,
inside `<manifest>` above `<application>`:

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

The plugin contributes the `<service>` entry via manifest merge; confirm the
merged manifest has `com.equimaps.capacitorblbackgroundgeolocation` present.

### 2. Notification channels

`localNotificationForNotify` selects one of two channel ids:

- `jltg-geofence` — the **alerting** channel (default importance: sound +
  vibration) for normal styles.
- `jltg-geofence-silent` — a **LOW-importance** channel (no sound, no vibration)
  for the Phase 33 "silent" style.

Create both on first run in the native layer (a tiny `MainActivity`/plugin
snippet, or `LocalNotifications.createChannel` at app start). Until they exist,
Android falls back to a default channel — alerts still post, but the silent style
won't be honoured. Wiring the channels is part of this manual half.

### 3. Grants

Needs **"Allow all the time"** location and a **battery-optimization exemption**
(the Phase 45 wizard automates detecting/deep-linking to these). Without "all the
time", the background service is downgraded to foreground-only and defeats the
phase.

### 4. Locked-pocket QA checklist

1. Build + sideload the APK (`docs/ANDROID_BUILD.md`).
2. As hider, place a zone and set a geofence threshold (e.g. 100 m).
3. Confirm the persistent "JLTG · hiding-zone alerts on" foreground-service
   notification appears.
4. Lock the phone, pocket it, and walk from inside → near the edge → across it.
5. Confirm a local notification fires on **approaching** and again on **leaving**,
   each once, with the screen off. Walk back in → **"Back inside"** fires once.
6. Toggle the alert style to **Off** and repeat one crossing → **no** notification.
7. Remove the zone → the foreground-service notification and any edge alert clear.

Record the results in a `docs/PHASE41_RESULTS.md` (mirror `PHASE40_RESULTS.md`).

## Files

- `src/native-geofence.js` — the bridge + pure helpers (wants / key / options /
  notify-mapping).
- `src/geofence.js` — native guard: keep the pill, defer alerts when in the shell.
- `src/app.js` — instantiate + `init()` (no-op off-device).
- `test/native-geofence.test.mjs` — 10 headless tests pinning the bridge contract.
- `service-worker.js` — SW cache → **v102** (new shell asset).
