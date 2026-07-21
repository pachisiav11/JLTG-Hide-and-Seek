# Build Plan — 2026-07-21 (Phases 27–45)

Everything scoped in this session's discussion, compiled and ordered **least →
most important** (which also tracks least → most work). Early phases are quick
web wins; the plan builds toward its centre of gravity — **real background
notifications on Android**, which is the core value of the hider tool.

Built in the usual rhythm: **one phase per commit, each with a headless test, SW
cache bumped when a cached shell asset changes, commit message explains the WHY,
push per phase.** Phases 27–38 are pure web (they improve the PWA *and*, because
the Android app loads the same site, the wrapped app for free). Phases 39–45 are
the Android/native track.

---

## Decisions locked this session

- **Android only** for now. iOS is out of scope (removes the iOS/Windows build
  blocker, App Store review, and the iOS-push caveats).
- **Both players run the Android app.** The browser PWA / desktop is
  **for testing and building only**, not a primary play surface.
- **The Android app loads the live site from GitHub Pages** (not bundled). The
  game already needs a network for map tiles + the relay, so requiring one at
  launch costs nothing — but we ship a small offline fallback screen and
  allowlist the Pages origin for the Capacitor plugin bridge.
- **Seeker-close delivery = Firebase Cloud Messaging (FCM).** One-time developer
  setup (a Firebase project + a config file + a server credential); players never
  see it, never sign in. Chosen over the Render-socket keep-alive because
  **delivery reliability is the product** and FCM is Doze-proof.
- **The server stays zone-blind.** For seeker-close, the relay FCM-forwards the
  seeker's raw coordinates to the hider's device; the **hider's phone computes
  the alert locally** (`evaluateApproach`) against its own zone. Preserves the
  "no game state on the server" principle.
- **No paid dependencies.** Background location uses Android's own **Geofencing
  API** (Play Services, free) for the hider and the **MIT community background-
  geolocation plugin** for the seeker; a ~1-day custom Capacitor plugin around
  `GeofencingClient` is the free fallback if the community plugin is flaky.
- **Wake Lock is rejected** (battery + pocket mistouch). Not built.
- **Seeker-close is measured from the zone CENTRE** (the hider-placed
  `focusZone.point`), never the hider's live location — which is exactly why the
  hider's phone can stay asleep for it. (`evaluateApproach` already does this;
  we only make it explicit in comments.)

## The background architecture (why the split matters)

The two alerts look like one feature but have different ceilings:

- **Geofence edge alert** — the moving thing is the *hider*, whose phone is
  asleep. Solved **entirely on-device** with Android **OS geofencing**: register
  two concentric regions (`radius − threshold` = "approaching", `radius` =
  "left"); the OS wakes the app on crossings even in Doze, at near-zero battery,
  and posts a **local** notification. No server, no Firebase.
- **Seeker-close alert** — the moving thing is the *seeker*, whose phone we keep
  awake with a native background-location **foreground service**. Seeker streams
  to Render → Render **FCM-forwards** each ping to the hider's token → the hider's
  app (woken by FCM, even locked) runs `evaluateApproach` and posts a **local**
  notification. With FCM the **hider needs no persistent service** — only the
  seeker does, and that seeker's mandatory "location on" service notification
  doubles as the location-in-use indicator.

Cross-cutting: the "notifications Off" setting (Phase 33) and the geofence
semantics (Phase 32) are defined in the **web layer** and must be honoured by the
**native** layer too (local notifications read the same setting; OS regions
implement the same state machine).

---

# Stage 0 — Quick web wins (least important)

### Phase 27 — Drop "(for WhatsApp)" from Copy-my-location (req #3)
- **Goal:** `📋 Copy MY location (for WhatsApp)` → `📋 Copy MY location`. The
  feature isn't WhatsApp-specific.
- **Files:** `src/games.js` (menu label near line 36; tidy the adjacent comment).
- **Tests:** none new (string-only) — state that in the commit.
- **Build:** SW bump (games.js is a cached shell asset).

### Phase 28 — Custom km approach-threshold input (req #4)
- **Goal:** In Live-share, add a **Custom** radio + a **km number input** beside
  the 500 m / 1 / 2 / 5 km presets.
- **Files:** `src/games.js` `openLiveShare` (add the radio + `<input
  type="number" step="0.1" min="0">`); new pure helper `parseApproachKm(str)` in
  `src/live-share.js` → metres (reject NaN/≤0, clamp to a sane max e.g. 50 km).
- **Persistence:** still stored in metres in `settings.approachThresholdM`.
- **Tests:** `parseApproachKm("1.5")===1500`, rejects junk/negative; a game test
  that a custom value drives an `evaluateApproach` crossing.
- **Build:** SW bump.

### Phase 29 — Declutter / relocate the pills (req #11)
- **Goal:** The bottom-right geofence + live-share pills are obstructive. Move
  them out of the toolbar's path, make them **collapsible/dismissible**, and
  ensure they **stack without overlapping** when both are present.
- **Files:** `styles.css` (position, stacking, compact state); small JS in
  `src/geofence.js` + `src/live-share.js` for a collapse/dismiss control.
- **Tests:** JSDOM/logic test that both pills mount without overlap and that
  dismiss hides the pill **without** stopping the underlying watch.
- **Build:** SW bump (styles.css + both modules).

---

# Stage 1 — Station interaction (reqs #1, #2)

### Phase 30 — Station long-press action chooser (req #2)
- **Goal:** **Single tap with no active tool = nothing.** **Long-press (or
  desktop right-click) a station → a 2-option sheet: 📝 Add note here /
  ❌ Eliminate ⟷ ♻️ Restore** (label reflects state). Remove the current
  tap-to-eliminate.
- **Files:** `src/stations-layer.js` — replace the `marker.click → toggle`
  wiring with a long-press detector mirroring `notes.js` (mousedown/mouseup +
  `LONG_PRESS_MS` 500 ms + 12 px move-tolerance; add `rightclick`). Reuse
  `addNote` (`src/notes.js`) for the note branch, `toggleStationElimination`
  (`src/stations.js`) for state.
- **Pure/testable:** extract `stationLongPressActions(station)` returning
  `[{id:"note"},{id:"toggle",label}]` so the menu contents are unit-tested
  without Maps.
- **Tests:** game test — long-press offers both actions; "note" drops a note at
  the station point; "toggle" flips `eliminated`; a plain click no longer
  mutates state.
- **Build:** SW bump.

### Phase 31 — Tap-the-map-to-select-nearest-station (req #1)
- **Goal:** A "Select on map" button in the Stations panel arms a one-shot pick
  mode; the next map tap **snaps to the nearest station** (points only, no name
  labels) and opens the Phase 30 chooser for it. Easier than hitting the tiny
  dot; mirrors the tools' `pick()` interaction.
- **Files:** new pure `nearestStation(list, point)` in `src/stations.js` (uses
  `metresBetween` from `src/geo.js`); Stations-panel button in `src/games.js`;
  reuse the `pick(1, …)` / `_claimMapClicks` pattern (`src/layers.js`) to capture
  one tap, then call the Phase 30 chooser.
- **Tests:** `nearestStation` picks the closest, ignores non-finite coords; game
  test that arming the mode + a tap near station B opens B's chooser.
- **Depends on:** Phase 30.
- **Build:** SW bump.

---

# Stage 2 — Geofence & notification correctness (web logic)

### Phase 32 — Geofence re-alert semantics (req #6)
- **Goal:** Stop the every-minute nudge. Fire **once per transition**: entering
  the near-edge band (approaching), crossing out, and returning inside (only if
  previously out — keep the "back in zone" alert). Re-approaching re-arms **only
  after** leaving the near-band; parked-outside stays silent.
- **Files:** `src/geofence.js` `evaluateGeofence` — replace the
  `MIN_RE_ALERT_MS` time-debounce + "still-out" branch with an **edge-triggered
  state machine** over a `band` value (`safe` / `near` / `out`); notify only on
  band change. This is the canonical semantics the native OS regions (Phase 41)
  will implement.
- **Tests:** heavy pure coverage — a walk `safe→near→out→near→safe` asserts
  exactly one notify per transition and **zero** repeats while parked in a band;
  a re-entry then re-exit re-alerts each time.
- **Build:** SW bump.

### Phase 33 — A real "notifications Off" (req #10)
- **Goal:** An **Off** that suppresses the system notification **and** buzz/tone
  — distinct from today's `silent` (which still posts a tray notification).
  Applies to **both** geofence and seeker-close; the pill still updates visually.
  This setting must also be read by the **native** local-notification path later.
- **Files:** `src/model.js` (add `"off"` to `geofenceAlertStyle`, or a dedicated
  `notificationsEnabled` flag — pick one, thread it); early-return in
  `src/geofence.js` + `src/live-share.js` `_fireNotification` (including the
  buzz/tone); Settings UI in `src/games.js`.
- **Tests:** with Off, the fire decision emits nothing and no buzz; other styles
  unchanged.
- **Build:** SW bump.

### Phase 34 — Surface the geofence control + honest caveat (reqs #8, #9 copy)
- **Goal:** Promote the geofence enable/threshold out of deep Settings to the
  **Hider tool** flow (and/or a dedicated menu entry). Include one honest line
  in the **web** app: *"Alerts only fire while the app is open. Install the
  Android app for background alerts."* (points at the native track).
- **Files:** `src/features.js` / `src/games.js` (Hider-zone flow surfaces the
  threshold), caveat copy.
- **Tests:** game test that setting the threshold from the new surface writes
  `settings.geofenceMetres` and starts the watch.
- **Build:** SW bump.

---

# Stage 3 — Foreground live map (reqs #5, #7)

### Phase 35 — "Location in use" indicator, foreground (req #5)
- **Goal:** A single clear persistent chip (e.g. **📍 Location on**) shown to
  both roles whenever **any** foreground GPS watch is active. (On the seeker's
  Android device this is *also* covered by the OS foreground-service notification
  from Phase 42 — this chip is the in-app foreground signal.)
- **Files:** small shared indicator (fold into the Phase 36 shared watch, or new
  `src/gps-status.js`), consumed by the DOM.
- **Tests:** activating any one watch shows the chip; deactivating all hides it.
- **Depends on / pairs with:** Phase 36.
- **Build:** SW bump.

### Phase 36 — Shared GPS watch + blue self-dot (req #7a)
- **Goal:** A gmaps-style **blue self-dot + accuracy ring** following the
  device's own GPS, **always on**. Introduce a **single shared geolocation
  watch** (`src/geo-watch.js` singleton) so geofence, live-share seeker, and the
  self-dot share one subscription instead of three.
- **Files:** new `src/geo-watch.js` (subscribe/unsubscribe, last-fix cache, ref
  count); new `src/self-location.js` (marker + accuracy `google.maps.Circle`);
  migrate `src/geofence.js` + `src/live-share.js` seeker onto the shared watch;
  wire in `src/app.js`.
- **Tests:** the shared watch fans one fix to N subscribers and clears the OS
  watch on the last unsubscribe; the self-dot tracks the latest fix.
- **Build:** SW bump.

### Phase 37 — Seeker red dot on the hider's map (req #7b)
- **Goal:** Render the live-shared seeker position as a **red dot** on the
  hider's map, updated on each ping (~60 s).
- **Files:** `src/live-share.js` (expose the latest seeker point via a small
  event/callback rather than only the pill); `src/self-location.js` or a sibling
  layer to draw the red marker; remove it on stop/disconnect.
- **Tests:** a simulated seeker ping renders/moves the red marker; disconnect
  removes it.
- **Depends on:** Phase 36.
- **Build:** SW bump.

---

# Stage 4 — In-app guide (new this session)

### Phase 38 — Guide / Help in the options tab
- **Goal:** The tool has grown complex; add a **Guide** section (Settings/options
  tab) explaining the question tools, stations, live-share, and the alerts. Built
  as a scaffold now; Phase 45 fills in the **Android permissions setup wizard**
  once the native track lands.
- **Files:** `src/games.js` (Settings → new "Guide" entry / sheet); content in a
  small `src/guide.js` or inline HTML.
- **Tests:** the Guide entry opens and renders sections (DOM smoke test).
- **Build:** SW bump.

---

# Stage 5 — Android native shell (packaging; prerequisite for background)

### Phase 39 — Capacitor Android shell loading GitHub Pages
- **Goal:** A buildable **Android APK** that is a WebView loading the live
  GitHub Pages site, mirroring the PWA. This is the container the background
  plugins attach to; no background behaviour yet.
- **Steps:**
  1. `npm i @capacitor/core @capacitor/cli @capacitor/android`; `npx cap init`.
  2. `capacitor.config` → set `server.url` to the GitHub Pages URL, with
     `server.allowNavigation` / `server.cleartext` as needed, and the plugin
     bridge allowed for that origin (so native plugins are callable from the
     remote page).
  3. `npx cap add android`; verify `npx cap run android` on a device.
  4. Bundle a **"No connection" screen** in the app (Capacitor `errorPath` /
     a bundled `offline.html`) so a dead signal shows a clear message instead of
     a blank WebView. It must contain: a short line explaining the app needs a
     connection to load, **brief steps to reload with connection** ("1. Turn on
     Wi-Fi or mobile data. 2. Tap Reload below (or fully close and reopen the
     app)."), and a **Reload button** that retries `server.url`. Keep it
     self-contained (no remote assets — it's the thing that shows when remote is
     unreachable).
  5. App icon + name; a **debug/self-signed release** key for sideloading to the
     group (no Play Store required).
- **Files:** new `android/` project, `capacitor.config.ts`, `package.json`
  additions, `docs/ANDROID_BUILD.md` (build + sideload steps for Windows +
  Android Studio).
- **Tests:** manual — APK installs, opens the site, tools work as in the PWA.
  Note the manual QA in the commit.
- **Build:** no SW bump (native project); document the build.

---

# Stage 6 — Background notifications (MOST important; the core of the tool)

### Phase 40 — Geofence spike (de-risks the free-plugin question)
- **Scope note:** this spike is about **on-device background location** (OS
  geofencing + the seeker's background-location plugin), **independent of FCM**.
  FCM only carries the seeker-close ping's last hop and needs no spike — but the
  geofence never touches FCM (it's computed on the sleeping hider's own device),
  and the seeker's background streaming needs this same free plugin. The question
  being retired: *do the free plugins actually fire in Doze on this phone's OEM?*
- **Goal:** Prove the free background path on the **real phone**. Bare shell +
  free plugin + one OS geofence region + a local notification; phone **locked in
  a pocket 20 min**, confirm the crossing notification arrives.
- **Steps:** add `@capacitor/local-notifications` (free, official); try the
  **community background-geolocation plugin** and/or Android's `GeofencingClient`
  for a single test region; log/notify on enter/exit; test locked + Doze
  (`adb shell dumpsys deviceidle force-idle`).
- **Outcome:** decision — community plugin holds up, or write the ~1-day custom
  `GeofencingClient` Capacitor plugin. Everything below depends on this answer.
- **Files:** spike branch; record findings in `docs/ANDROID_BUILD.md`.
- **Tests:** manual device test (documented). No web changes.

### Phase 41 — Track A: hider background geofence (self-contained)
- **Goal:** Register **two concentric OS geofence regions** from the hider's
  `focusZone` — `radius − geofenceMetres` (exit = "approaching the edge") and
  `radius` (exit = "left the zone"), plus enter events for "back in zone" — and
  post **local notifications** implementing the Phase 32 semantics. Honour the
  Phase 33 "Off" setting. No server involved.
- **Steps:** on zone set/change (and on app start with a zone), (re)register the
  regions via the plugin/native bridge; map OS enter/exit callbacks → the same
  notify payloads `evaluateGeofence` produces; bridge native events back into the
  web layer so the foreground pill/state stays consistent (`geo-watch` / a
  Capacitor event listener).
- **Files:** `src/native-geofence.js` (bridge), native plugin config, wiring in
  `src/geofence.js` (native path when running in the app, web `watchPosition`
  path otherwise).
- **Permissions:** needs **"Allow all the time"** location + battery-optimization
  exemption (see Phase 45).
- **Tests:** unit-test the region math (`regionsForZone(zone, threshold)` pure
  fn); manual locked-pocket device test of each transition.
- **Depends on:** Phases 39, 40 (and semantics from 32).

### Phase 42 — Track B (1/3): seeker background streaming
- **Goal:** The seeker's phone keeps streaming GPS to the Render relay while
  asleep, via a native background-location **foreground service** (ongoing
  "JLTG is sharing your location" notification — this is the seeker's req-#5
  indicator). Emit at the existing ~60 s cadence + rate limit (Phase 19).
- **Steps:** community background-geolocation plugin with a distance filter +
  60 s interval; on each background fix, emit `share-location` to the relay
  (reuse `LiveShare`/socket). Ensure the socket reconnects after Doze network
  gaps.
- **Files:** `src/native-seeker-location.js` (bridge), wiring in
  `src/live-share.js` (native background path vs web foreground path).
- **Permissions:** "Allow all the time" + battery exemption (Phase 45).
- **Tests:** manual — seeker phone locked, relay still receives pings.

### Phase 43 — Track B (2/3): FCM plumbing
- **Goal:** Stand up FCM end-to-end. Both apps obtain a device token; the hider
  registers its token against the session code on join; the server can send to a
  token.
- **Steps (one-time dev setup):**
  1. Create a **Firebase project** (free); download `google-services.json` into
     the Android app; add `@capacitor/push-notifications` + FCM.
  2. Server: add `firebase-admin`; store the **service-account key** as a Render
     **env var** (never commit it). Add a `register-token` relay event/endpoint
     mapping `sessionCode → hiderToken`.
  3. On `startAsHider`, obtain the FCM token and send `register-token`.
- **Files:** `server.js` (token registry + admin init from env), Android FCM
  config, `src/live-share.js` (token registration), `docs/ANDROID_BUILD.md`
  (Firebase setup steps).
- **Tests:** server unit test that a registered token is looked up by code and
  that a missing key/env degrades gracefully (no crash, logs).
- **Note:** keep the service-account JSON **out of git** (env var only); double-
  check `.gitignore` before committing.

### Phase 44 — Track B (3/3): FCM forward + hider computes locally
- **Goal:** On each seeker `share-location`, the server sends a **high-priority
  FCM data message** to the hider's token carrying the raw seeker coords (server
  never sees the zone). The hider's app — woken even when locked — runs
  `evaluateApproach` against its **local** `focusZone.point` (the hider-placed
  centre) and posts a **local** notification if crossing; when foreground it also
  updates the red dot (Phase 37) + pill. Honour Phase 33 "Off".
- **Files:** `server.js` (FCM data-message forward on each ping, in addition to
  the socket emit for foreground viewers); `src/live-share.js` +
  `src/native-push.js` (handle the data message in background/foreground →
  `evaluateApproach` → local notification).
- **Tests:** server test that a seeker ping triggers a forward to the hider
  token; device test that a locked hider gets the alert when the seeker crosses
  the threshold. Reuse `evaluateApproach` tests unchanged.
- **Depends on:** Phase 43.

### Phase 45 — Permissions setup wizard (completes Phase 38 + reqs #8/#9)
- **Goal:** Background alerts silently fail without **"Allow all the time"**
  location and a **battery-optimization exemption**, both buried by Android/OEMs.
  The Guide (Phase 38) gains a **setup wizard**: detect current grants, explain
  why each is needed, deep-link to the exact settings screen, and clearly flag
  the feature as inactive until granted.
- **Files:** `src/guide.js` / `src/native-permissions.js` (query grants via the
  plugin, deep-link intents), Guide UI in `src/games.js`.
- **Tests:** logic test of the grant-state → wizard-step mapping; manual device
  walkthrough.
- **Depends on:** Phases 38, 41, 42.

---

## Build order summary (least → most important)

27 · 28 · 29 → 30 → 31 → 32 · 33 · 34 → 36 → 35 → 37 → 38 →
**39 → 40 → 41 · 42 → 43 → 44 → 45**

The bold tail is the point of the exercise. 40 (the spike) gates 41/42 — do it
before committing to the free plugins. 39 must precede everything native. 43
precedes 44. 36 precedes 35 and 37.

## Cross-cutting discipline (unchanged)
- One commit + push per phase; message explains the WHY; `Co-Authored-By` footer.
- Every **web** phase ships a headless test; native phases document their manual
  device QA (locked-in-pocket where relevant).
- Bump the SW cache version whenever a cached shell asset changes.
- Web phases (27–38) auto-deploy to GitHub Pages and thus reach the Android app
  (which loads Pages) with no rebuild. Native phases (39–45) require an APK
  rebuild + re-sideload.
- Never commit the Firebase service-account key or `google-services.json` secrets
  — env vars only; verify `.gitignore` before each native commit.
