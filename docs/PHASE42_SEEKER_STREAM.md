# Phase 42 — seeker background streaming (Track B 1/3)

**Status:** code + headless tests committed (`src/native-seeker-location.js`,
`test/native-seeker-location.test.mjs`, 8 tests). The **device half is manual** —
the seeker's phone locked, relay still receiving pings.

## What this phase does

Track B carries the seeker's live position to the hider. Unlike the hider
geofence (Track A, on-device), the moving thing here is the SEEKER, so the
seeker's phone must keep streaming GPS to the Render relay even while locked in a
pocket.

The web seeker (`src/live-share.js` `startAsSeeker`) rides the shared foreground
`GeoWatch`, which the OS throttles/evicts on lock. This phase adds
`NativeSeekerWatch` — a **GeoWatch-compatible** adapter around the same
`@capacitor-community/background-geolocation` **foreground service** the Phase 40
spike proved Doze-proof. Because it exposes the exact GeoWatch surface
(`subscribe`/`active`/`lastFix`/`onActiveChange`, fixes shaped `{lat,lng,accuracy,at}`),
LiveShare's Phase 23 throttle-and-emit logic rides it **unchanged** — the only
change is *which* watch the seeker subscribes to:

- **Native shell** (`bgWatch` present AND `isNativeCapacitor()`): the seeker
  subscribes to `NativeSeekerWatch`; its persistent "JLTG is sharing your
  location" foreground-service notification doubles as the seeker's req-#5
  "location in use" indicator.
- **Browser / PWA**: `NativeSeekerWatch.available` is false, so the foreground
  `GeoWatch` is used exactly as before.

The 60 s outbound throttle (Phase 23) still caps the cadence, so the relay's rate
limit (Phase 19) is never approached even when the plugin reports frequently.

FCM is **not** in this phase. The socket forward already reaches a foreground
hider; Phases 43–44 add the FCM last hop so a **locked** hider is woken too.

## Manual half — device QA

1. Manifest permissions: same set as Phase 41
   (`docs/PHASE41_HIDER_GEOFENCE.md` §1) — `ACCESS_BACKGROUND_LOCATION`,
   `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, etc. Grant "Allow all the
   time" + battery-optimization exemption (Phase 45 automates this).
2. Two devices (or one device + a desktop hider). Seeker: join a session as
   seeker; confirm the "JLTG is sharing your location" foreground-service
   notification appears.
3. Lock the seeker's phone, pocket it, and walk. On the hider's foreground map,
   confirm the red seeker dot keeps updating (~60 s cadence) with the seeker's
   screen off.
4. Confirm the relay is not spammed (≤ 1 emit / 60 s) — check the seeker pill
   cadence or the server logs.
5. Stop sharing → the foreground-service notification clears and the red dot
   removal fires on the hider.

Record results in a `docs/PHASE42_RESULTS.md`.

## Files

- `src/native-seeker-location.js` — the `NativeSeekerWatch` adapter + pure
  `seekerWatcherOptions`.
- `src/live-share.js` — `bgWatch` / `isNative` options; `startAsSeeker` prefers
  the background watcher on-device.
- `src/app.js` — construct `NativeSeekerWatch`, pass as `bgWatch` to `LiveShare`.
- `test/native-seeker-location.test.mjs` — 8 headless tests (adapter contract +
  LiveShare native/foreground path selection).
- `service-worker.js` — SW cache → **v103** (new shell asset).
