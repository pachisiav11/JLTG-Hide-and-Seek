# Changelog

Built phase-by-phase per [`GUIDE.md`](GUIDE.md). Each entry is a completed, pushed phase.

---

# v2 major build (in progress)

A rebuild driven by [`MAPPER_ANALYSIS.md`](MAPPER_ANALYSIS.md) — a measured review of
[taibeled/JetLagHideAndSeek](https://github.com/taibeled/JetLagHideAndSeek), in which the
reference mapper was cloned, run, and driven through 40 scripted test games to establish
what it does well and where it is wrong. The improvement programme is §10 of that document;
the phases below follow its §10.8 order.

**The last stable v1 build (Phases 0–51) is the `v1-stable` branch.** Everything under this
heading is newer than that and may be mid-change.

Scope was fixed up front by the constraints already recorded in `IMPROVEMENTS.md`: no stack
rewrite, no migration off Google Maps, no reversion to forced auto-answer, no premature
backend. These are patterns borrowed from the reference, not its architecture.

## v2 Phase 1 — Correctness harness (§10.1 items A, B, C)

The properties the app rests on, asserted for the first time. No behaviour change a player
would notice; this phase exists so every later phase has something to break against.

- **Item C — the hider-survival property** (`src/oracle.js`, `test/hider-survives.test.mjs`,
  12 tests). New truthful-answer oracle: given a step and a KNOWN hider position, derive the
  answer a truthful hider would give. Written from the game's semantics ("hotter means closer
  to B"), independently of how `tools.js` builds its polygons, so agreement between the two is
  evidence rather than tautology.

  The harness then folds a board of truthfully-answered questions and asserts the hider is
  still inside the surviving area — across a 7×7 interior grid, for every tool, at several
  radii/distances/candidate sets, and for a compound seven-question board. **49 positions ×
  every tool: none lost.** This is the one guarantee that matters (an under-elimination costs
  a turn; a false elimination loses the game invisibly) and nothing checked it before.

  Deliberately *not* wired into live answering — `IMPROVEMENTS.md` is explicit that
  auto-answer was tried and removed. The oracle is a test fixture and a future post-game
  debrief tool, per MAPPER_ANALYSIS §10.6.

- **Item B — the partition invariant** (`test/partition-invariant.test.mjs`, 11 tests). For
  every question, the region kept by "yes" and the region kept by "no" must together be the
  whole board and must not overlap. One property, but it catches an entire family of bugs
  (inverted side, asymmetric `keep` handling, difference-where-intersect-belonged), because
  each shows up as a gap or an overlap. Extended to tentacles, which is not binary — every
  candidate plus the miss must partition — and asserts the *intended* asymmetry for
  nearest-LINE cells, which overlap on shared track by design.

- **Item A — a failed question must never look like an applied one** (`src/layers.js`,
  `src/tools.js`, `test/failure-reporting.test.mjs`, 7 tests). Two real gaps closed:

  1. `computeActiveArea` reported failures with a reason (`"compute"` vs `"union"`), but
     `layers.js` recorded only `"union"`. A step whose geometry threw was flagged solely
     because the guide loop happens to recompute and throw again — coincidence, not design —
     and was then reported as *"failed to render"*, which understates it badly: a seeker told
     the overlay is missing will still trust the shading. The three cases now report
     separately and accurately, and a compute failure is no longer double-counted as a guide
     failure (the two notices contradicted each other).
  2. **Tentacles could silently eliminate nothing.** When a candidate's Voronoi cell does not
     reach the seeker's circle, the recorded answer describes no point on the board — and the
     code returned `eliminated: null`, indistinguishable from a question that legitimately
     rules nothing out. It now throws, routing to the same ⚠ badge a degenerate partition
     already uses. Still under-eliminates rather than blanking the board (an impossible answer
     is more often a stale candidate list than a contradictory hider) — the change is that it
     is no longer silent.

  The suite also pins two *non*-failures, because "this is hard to break" is worth keeping:
  coincident candidates are rescued by `dejitter`, and exactly-collinear seeds still partition.

Suite: **756 → 786 tests, all passing.**

## v2 Phase 2 — Question-model upgrades (§10.2 items F, G, H, I)

Four changes to what a question *is* and what the seeker can do with one. All small; between
them they close the biggest usability gap against the reference mapper.

- **Item F — derive the seeker's own distance** (`src/geo.js`, `src/layers.js`,
  `test/derive-distance.test.mjs`, 10 tests). The measuring cards buffer a reference by the
  seeker's distance to it, and the seeker used to type that number. The app was holding both
  operands the whole time — the GPS fix and the reference geometry. Typing the number between
  them is a pure error surface (a paced estimate, a metres/feet slip, a stale value from the
  previous question), and each of those lands as a confidently wrong elimination that looks
  exactly like a right one.

  New `distanceToGeometryM` in `geo.js` handles every reference shape the cards produce —
  point sets, sourced lines (many disjoint OSM ways), drawn areas. The judgement call is the
  polygon case: a seeker standing *inside* the reference is at distance **zero**, not at the
  distance to its edge, or someone standing in a park would answer "beyond the nearest park".

  Derived is the default but never a lock: it prefills only while the field is untouched, any
  keystroke stops it, and a 📍 button re-measures on demand. It runs in the background rather
  than blocking the sheet, because a cold GPS fix takes seconds. No fix, or an unmeasurable
  reference, falls back to manual entry with a reason.

- **Items G + H — `draft` and `hidden`** (`src/model.js`, `src/layers.js`, `styles/main.css`,
  `test/draft-hidden-steps.test.mjs`, 6 tests). A step produces exactly two things: an
  elimination and its guides. `enabled` switched both off together, so there was no way to ask
  for either alone. The two missing states are exact complements:

  - **draft** — guides yes, elimination no. *"Show me where this question would cut, without
    spending it."* Hide & Seek is a game about choosing which question to ask next and nothing
    here helped with that decision before.
  - **hidden** — guides no, elimination yes. On a ten-question board it is the ink that makes
    the map unreadable, not the shading, and wanting a clean map should not require un-applying
    an answer.

  A deliberate **deviation** from the reference, which has a global planning mode plus a
  per-question lock, and uses `hidden` for what `enabled: false` already means here. A global
  mode was rejected: with questions committed on add (ours are), one toggle silently
  un-applies an entire reasoned-about board. Per-question is the same capability without that
  failure mode, and it composes. The two flags are mutually exclusive by construction — a
  hidden draft is just `enabled: false` wearing two flags — and both default off, so every
  game ever written reads correctly with no migration.

  The board says when it is showing drafts, because a preview boundary over unshaded ground is
  otherwise indistinguishable from a question that eliminated nothing.

- **Item I — warn when a partition has collapsed** (`src/tools.js`, `src/layers.js`,
  `test/degeneracy-note.test.mjs`, 8 tests). A Voronoi over one seed is a valid partition that
  answers nothing; over two it is a single bisector — a Thermometer wearing another card's
  name. Both are legitimate to ask and both are far weaker than the card's wording implies,
  with no hint from the geometry. The Metro Lines card already carried a hand-written warning
  about this and it was the most useful sentence in the flow; every other Voronoi card had the
  same failure mode and said nothing.

  New `partitionDegeneracyNote` states the **consequence**, not the diagnosis — "this can only
  tell you whether they're within 2 km of you", not "degenerate partition" — and distinguishes
  the one-candidate case *with* a reach (collapses to a radius question) from *without* one
  (Matching, where it can eliminate nothing at all). Now shown by Tentacles points, Tentacles
  lines and Matching-nearest alike.

Suite: **786 → 810 tests, all passing.**

## Phases 47–51 — playtest fixes: live-share reliability, pill clarity, server-computed locked-device alert
A real-device playtest found the seeker's red dot not reaching the hider's map and no
clear way to tell whether Live location share settings had actually saved. Investigated
live against the real Render backend + a two-tab local session (not just headless tests)
to separate genuine bugs from infra noise before touching code.

- **Phase 47 — live-share mechanics** (`src/live-share.js`, `src/native-seeker-location.js`,
  `src/games.js`, 6 new tests). Two real bugs: `NativeSeekerWatch`'s `distanceFilter: 10`
  silently dropped every fix unless the seeker's phone had physically moved 10 m — exactly
  what a same-room test looks like — now `0`, matching `native-geofence.js`'s own choice
  and reasoning. And a dropped relay connection left the pill frozen on stale text with no
  signal anything had failed; `LiveShare` now tracks transport connect/disconnect/
  connect_error and surfaces it in both pills. The 60 s emit throttle default drops to `0`
  (instantaneous — the relay's own token-bucket rate limit is the real safety net) per the
  "make it instantaneous" ask. Also fixed the ambiguous "Seeker X from zone" pill text to
  say "from zone centre". Verified end-to-end: connect/disconnect/reconnect all reflected
  live in the pill against the real local relay; a ping reached the red dot with no delay.
- **Phase 48 — hider geofence pill, plain green/red** (`src/geofence.js`, `src/pill-stack.js`,
  `styles/main.css`, 4 new tests). The pill's colour used to come from regex-sniffing its
  own text, so "comfortably safe, deep inside the zone" never went green — same neutral
  gray as outside. `pill-stack`'s `setWarn(bool)` becomes `setTone("ok"|"warn"|null)`,
  driven by `evaluateGeofence`'s own `inside` boolean. Verified live (post service-worker
  cache-bust): `rgba(21,128,61)` inside, `rgba(220,38,38)` outside.
- **Phase 49 — Live location share sheet actually saves** (`src/games.js`). Only the Close
  button (and connecting) persisted a changed threshold — the header ✕ and the backdrop,
  how every other sheet is dismissed, silently discarded it, with no feedback either way.
  Added an `onClose` save on every dismissal path plus an explicit "💾 Save" button that
  persists immediately (`store.saveNow`) and stays open with a confirmation toast. No
  reconnect needed — `_onSeekerPing` already re-reads the threshold from the store on every
  ping. Verified live: dismissing via the header ✕ after changing the radio now persists
  `settings.approachThresholdM`.
- **Phase 50 — build stamp in Instructions** (`src/build-info.js`, `scripts/build-config.js`,
  `src/games.js`, 6 new tests). A quiet footer line — `Build <short-sha> · <UTC timestamp>`
  — so a tester can confirm which push they're actually running. Render sets
  `RENDER_GIT_COMMIT` on every build automatically; degrades to "Build dev · unknown build
  time" locally, where `build-config.js` never runs.
- **Phase 51 — server-computed seeker-close alert for a locked/killed hider** (`fcm.js`,
  `hider-tokens.js`, `relay-forward.js`, `server.js`, `src/geo.js`, `src/live-share.js`,
  `src/native-push.js`, 41 new/updated tests). Location *collection* while locked already
  worked (the native background-location service for the seeker, the native background
  geofence for the hider) — the gap was the seeker-close *alert*, which needed the hider's
  own JS to run `evaluateApproach` after an FCM data message woke the app. Locked long
  enough that Android kills the process, no JS runs and the alert silently never fires; a
  data-only FCM message can't fix that, only a genuine FCM *notification* message can,
  since Android's Play Services layer displays that from the system tray with zero app code
  involved. Per the explicit go-ahead that cloud compute is fine for the locked case: a
  native hider now registers zone centre + threshold + alert style with the relay
  (`set-hider-zone`, `HiderTokenRegistry.registerZone`) on connect and on every relevant
  settings change; the server runs the *exact same* `evaluateApproach` (moved to `geo.js`
  so client and server share one definition) and sends a real FCM notification on a
  crossing, honouring "Off" server-side too. The foreground socket path (app alive, any
  platform) is unchanged — still decided on-device. A narrow, session-scoped, TTL'd
  exception to the relay's "stays zone-blind" principle. Code-complete; still pending the
  one-time Firebase setup already flagged from Phase 43 (degrades gracefully without it,
  same as the existing FCM plumbing).
- **756 tests pass** (was 709 at the start of this batch).

## Phase 46 — Hider/Seeker role gate on the geofence
Bug: `src/geofence.js`'s edge-alert ("near the edge" / "you've left the zone") and its
Android background twin (`src/native-geofence.js`) fired for **whoever had the app
open**, keyed only on a placed Hider-zone + threshold. But the Hider-zone is also a
seeker-side tool (`src/focus.js`) for shading in a *guess* at the hider's position — so a
seeker using it got alerts about their own GPS crossing a zone they were never meant to
stay inside.
- New per-game setting `settings.role: "seeker" | "hider"` (`src/model.js`), defaulting
  to `"seeker"`.
- A 2-choice **"I am the"** toggle added to the 🎯 Hider-zone panel (`src/focus.js`,
  `Focus.setRole`) — the only place it's surfaced, per design. Writing it reconciles the
  store-subscribed watchers immediately, exactly like the existing threshold control.
- Both `Geofence._reconcile` (web) and `wantsNativeGeofence` (Android background) now
  gate on `role === "hider"`; switching away from Hider mid-game stops the watch/watcher
  and dismisses any stale tray notification, the same path Phase 31.5 already used for
  zone removal.
- SW cache **v111 → v112**. **682** `node:test` tests pass (+8 for the role gate).

## Phases 41–45 — Android background notifications, Stage 6 of [`BUILD_PLAN_2026-07-21.md`](BUILD_PLAN_2026-07-21.md)
The core of the Android track: real alerts on a **locked** phone. Phase 40's
on-device Doze spike **PASSED** (`docs/PHASE40_RESULTS.md` — the free
`@capacitor-community/background-geolocation` foreground service survives Doze on
the target OEM), which chose the architecture below: ride the foreground service,
compute on-device, and use FCM only for the seeker→hider last hop. Every phase
ships the **headless-buildable half** (pure logic + bridges + Node tests, committed
and pushed) and documents the **manual device/Firebase half** it can't run from a
desk — the same `[SCAFFOLDED]`/`[WIRED]` discipline as Phases 39/40.

- **Phase 41 — hider background geofence** (`src/native-geofence.js`, 10 tests).
  While a hider zone + threshold exist, a foreground-service watcher feeds every
  background fix to the **same `evaluateGeofence` band machine** the web path uses,
  posting a `@capacitor/local-notifications` alert on each transition — honouring
  Phase 33 "Off"/"silent", resetting the baseline on a zone re-place, and cancelling
  stale alerts on removal (native mirror of Phase 31.5). `src/geofence.js` keeps its
  pill but defers alerts to this in the shell, so a crossing is never double-fired.
- **Phase 42 — seeker background streaming** (`src/native-seeker-location.js`, 8
  tests). `NativeSeekerWatch` is a **GeoWatch-compatible** adapter around the same
  foreground service, so `LiveShare`'s Phase 23 throttle rides it unchanged — the
  seeker keeps streaming to the relay with the screen off; its persistent "sharing
  your location" notification is the req-#5 indicator. Ref-counted, with a race
  guard so an unsubscribe can't leak a service.
- **Phase 43 — FCM plumbing** (`hider-tokens.js`, `fcm.js`, `src/native-push.js`,
  22 tests). The hider mints its FCM token and registers it against the session
  code; the server keeps an expiring `code→token` registry (no game state — a token
  is a delivery address). `createFcm` **degrades gracefully**: `firebase-admin` is
  lazy + optional, and a missing/broken key disables FCM while the Overpass proxy
  and socket relay keep working (`npm test` never needs the dep).
- **Phase 44 — FCM forward + hider computes locally** (`relay-forward.js`,
  `src/native-local-notify.js`, 11 tests). On each seeker ping the server forwards
  the **raw coordinates** over high-priority FCM — staying **zone-blind** — and the
  woken hider runs `evaluateApproach` against its **local** zone, posting a local
  notification once per crossing. The FCM coords route through the *same*
  `_onSeekerPing` path as a socket ping, so pill, red dot, and the once-per-crossing
  debounce are all reused.
- **Phase 45 — permissions setup wizard** (`src/native-permissions.js`, 11 tests).
  The Guide's Android section becomes a live wizard: detect each grant (location
  "all the time", notifications, battery-exemption), explain it, deep-link to the
  exact settings screen, and flag background alerts **inactive** until all are
  granted. Strict — an unknown grant is never a false all-clear, and "while using"
  never passes as "all the time".
- Cross-cutting: SW cache **v101 → v106** (one bump per shell-asset phase); secrets
  stay out of git (`.gitignore` blocks `google-services.json` / `serviceAccount*.json`;
  the Firebase key lives only in the `FIREBASE_SERVICE_ACCOUNT` Render env var).
  **689** `node:test` tests pass (627 → 689, +62). Per-phase device/Firebase QA:
  `docs/PHASE41_HIDER_GEOFENCE.md` … `docs/PHASE45_PERMISSIONS_WIZARD.md`.

## Phase 40 — [WIRED] Doze spike harness, Stage 6 of [`BUILD_PLAN_2026-07-21.md`](BUILD_PLAN_2026-07-21.md)
The headless-buildable half of the real-phone Doze spike that gates the whole
native background track. The **question**: on a locked, screen-off phone in Doze,
does a *free* background-location plugin keep firing — so the hider geofence can
ride a simple foreground service — or must it fall back to native OS geofencing +
FCM? This phase builds the experiment; the answer needs a device.

- **`src/bg-spike.js`** — a self-contained on-device harness, **inert** unless the
  URL is `#bgspike` **and** it's inside the Capacitor native shell (never touches a
  web/PWA boot). It opens the `@capacitor-community/background-geolocation`
  **foreground-service** watcher, stamps every fix and **persists the log to
  `localStorage`** (so a Doze-kill of the WebView can't erase the evidence), drops
  a geofence and fires a `@capacitor/local-notifications` alert on each crossing —
  reusing the **same `evaluateGeofence` band machine** the real hider uses — and
  reduces the log to a **PASS/FAIL verdict from the inter-fix gaps** (a gap > 4× the
  30 s cadence = the OS suspended the plugin).
- **`test/bg-spike.test.mjs`** — 9 headless tests pinning the verdict reduction: a
  steady run passes, one Doze-sized gap fails, no/too-few fixes resolve to an honest
  "can't tell", and the tolerance is configurable. This is what makes the on-device
  run conclusive rather than a vibe.
- **`docs/PHASE40_DOZE_SPIKE.md`** — the conclusive runbook: build the spike APK,
  the two required `AndroidManifest` edits, grant "Allow all the time" + the
  battery-exemption, force Doze with `adb shell dumpsys deviceidle force-idle`, and
  read the verdict — run **twice** (battery Unrestricted vs. optimized) to size the
  exemption's effect for the Phase 45 wizard.
- Plugins added to `package.json` devDeps (native-build-only); wired in `src/app.js`
  behind the hash+native guard. SW cache **v100 → v101**; **627** `node:test` pass.
- **Still manual (needs a phone):** the actual spike run and its PASS/FAIL outcome,
  which picks the Phase 41 architecture.

## Phases 27–31 — Web UX batch, Stages 0–1 of [`BUILD_PLAN_2026-07-21.md`](BUILD_PLAN_2026-07-21.md)
The quick web wins + station-interaction stages of the 27–45 plan (the tail of
which is Android-native background notifications). All pushed to `main`, each with
a headless test and an SW cache bump; 580 `node:test` tests pass. Stage 2 (Phase
32+) is next.

- **Phase 27 — Copy-my-location label.** Dropped "(for WhatsApp)" from the menu
  label (the button copies coordinates for *any* chat) and genericised the comment.
  String-only; SW → v88.
- **Phase 28 — Custom km approach-threshold.** Live-share gains a **Custom** radio +
  km number input beside the 500 m / 1 / 2 / 5 km presets. New pure
  `parseApproachKm(str)` (`src/live-share.js`) converts km → metres, rejecting junk /
  ≤0 as `null` and clamping to 50 km; still stored in metres in
  `settings.approachThresholdM`. Also fixed a latent double-check (value 0 lit both
  Off and 2 km). SW → v89.
- **Phase 29 — Shared, dismissible pill stack.** New `src/pill-stack.js`: one fixed
  container lifted clear of the bottom-centre toolbar, holding the geofence +
  live-share pills as flex-column children so they stack without overlap by
  construction. Each pill gains a dismiss (×) that hides only the DOM node — the GPS
  watch keeps running. SW → v90.
- **Phase 30 — Station long-press chooser.** A plain tap on a station now does
  **nothing**; a long-press (touch) / right-click (desktop) opens a 2-option sheet —
  Add note here / Eliminate ⟷ Restore. Pure `stationLongPressActions(station)`;
  reuses `addNote` + `toggleStationElimination`. SW → v91.
- **Phase 31 — Select-nearest-station on map.** A "Select on map" button in the
  Stations panel arms a one-shot map pick that snaps the tap to the closest station
  (new pure `nearestStation(list, point)`) and opens the Phase 30 chooser for it.
  SW → v92.
- **Phase 31.5 — Bugfix: stale geofence notification after zone removal.**
  Removing the hider zone stopped new alerts but left the last one sitting in the
  system tray (the SW shows it with a fixed tag; nothing closed it), so it looked
  like the app was still watching a zone that was gone. New reusable
  `clearNotification(tag)` (`src/sw-notify.js`) + a `CLEAR_NOTIFY` handler in the
  service worker close tagged tray notifications; `Geofence` fires it whenever the
  watch stops (zone removed / threshold off / game switch / teardown), and
  `LiveShare` clears `jltg-seeker-close` on disconnect. SW → v93.

## Phases 32–39 — Stages 2–5 of [`BUILD_PLAN_2026-07-21.md`](BUILD_PLAN_2026-07-21.md)
Notification correctness, the foreground live map, the in-app Guide, and the
Android shell scaffold. All pushed; each web phase has a headless test + SW bump;
618 `node:test` tests pass (SW at v100).

- **Phase 32 — Edge-triggered geofence re-alerts.** Replaced the every-minute
  "still outside" nudge with a state machine over three bands (safe / near / out)
  that fires once per transition and is silent while parked. Canonical semantics
  the native OS regions (Phase 41) will mirror.
- **Phase 33 — Real "notifications Off".** Added `off` to `geofenceAlertStyle`
  (off | silent | vibrate | vibrate-tone), suppressing the notification *and*
  buzz/tone for both the geofence and seeker-close alerts (pill still updates).
- **Phase 34 — Surfaced the edge alert + honest caveat.** The threshold is now
  set in the 🎯 Hider-zone panel (`Focus.setGeofenceThreshold`), and both surfaces
  carry "alerts only fire while the app is open — install the Android app".
- **Phase 36 — Shared GPS watch + blue self-dot.** New `geo-watch.js`
  ref-counted singleton (one `watchPosition` fanned to N subscribers) + a
  gmaps-style blue self-dot (`self-location.js`); the geofence + seeker migrated
  onto it.
- **Phase 35 — "📍 Location on" chip.** A shared indicator (`gps-status.js`)
  shown whenever any GPS watch is active, driven by `GeoWatch.onActiveChange`.
- **Phase 37 — Live seeker red dot.** `LiveShare` emits each ping's point via
  `onSeekerPoint`; `seeker-dot.js` draws/moves/removes a red marker on the
  hider's map.
- **Phase 38 — In-app Guide.** `guide.js` — a Settings ▸ 📘 Guide sheet covering
  stations, live-share, and alerts, with an Android section scaffolded for the
  Phase 45 permissions wizard.
- **Phase 39 — Capacitor Android shell (scaffold).** `capacitor.config.ts`
  (loads the live Pages site), a self-contained `capacitor-www/offline.html`
  fallback, Capacitor devDeps, and [`docs/ANDROID_BUILD.md`](docs/ANDROID_BUILD.md).
  The APK build + device QA are a documented manual step.
- **Phase 31.5 — Bugfix.** Removing the hider zone now dismisses the outstanding
  geofence tray notification (new `clearNotification(tag)` + a `CLEAR_NOTIFY` SW
  handler); it no longer lingers on the lock screen.

## Phase 7 — Guide-rendering & interaction polish
Post-launch improvements from [`IMPROVEMENTS.md`](IMPROVEMENTS.md); no new deps, no
hosting impact (Static Site only).
- **Per-step guide differentiation.** Each enabled question now draws its reference
  guides (Radar circle, Thermometer bisector, division/region outlines, drawn lines)
  in the next colour of a cycling palette, so two open questions of the same tool —
  e.g. two Tentacles — are visually distinguishable. Incidental Voronoi cell edges
  stay faint. Elimination math was already order-independent; this closed a pure
  rendering gap (`src/layers.js`).
- **Draggable Radar / Thermometer anchors.** The Radar centre and Thermometer A/B
  points are now drag-to-reposition markers; a mis-tapped point is corrected by
  dragging instead of restarting the tool. A drag rewrites the step's inputs (region
  recomputes live) and is rejected + snapped back if dropped outside the play area.
- **Colour-blind-safe palette.** A Settings toggle (persisted in `localStorage`,
  applied live with no re-fetch) swaps every shaded layer + guide between the default
  vivid palette and an Okabe-Ito colour-blind-safe one (`src/palette.js`).
- **Suggested game-area size tier.** Assembling the game area now surfaces its area
  and a Small / Medium / Large / Very large tier (in the add-zone toast and the Zones
  panel), honouring the metric/imperial units setting.

## Phase 14 — Rebuild the Android APK (runbook prepared; blocked)
Cannot be completed here: rebuilding the thin TWA wrapper needs the app live on Render,
the Android toolchain, a signing keystore, and a device to test. Fabricating an APK or
bumping the version pill without a real build would misreport the outcome, so instead:
- Wrote [`APK_REBUILD.md`](APK_REBUILD.md) — a turnkey re-point runbook (Bubblewrap init
  against the deployed `manifest.webmanifest`, keep it a thin wrapper, replace
  `download/JLTG.apk`, bump `install_guide.html`'s version pill, device sanity check).
- Added [`twa-manifest.template.json`](twa-manifest.template.json) mirroring the PWA
  manifest, with host/URL placeholders to fill with the Render URL.

## Phase 13 — Live multiplayer sync (IMPLEMENTED)
Design doc written first ([`MULTIPLAYER_DESIGN.md`](MULTIPLAYER_DESIGN.md)); the review
gate was then explicitly overridden by the developer after Phases 7–12 were assured
working in-browser, so v1 was built and verified end-to-end.
- **Socket.IO relay** added to the existing Express service ([`server.js`](server.js)):
  rooms keyed by a session code, presence, snapshot cache for late joiners, echo via
  `socket.to(room)` — a relay, not a store. Same one Node Web Service as the Overpass
  proxy (`render.yaml` unchanged; `socket.io` added to `package.json`).
- **Client sync engine** ([`src/sync.js`](src/sync.js)): loads the Socket.IO client from
  the backend (no build step), derives **semantic events by diffing the store** (no
  mutation-site instrumentation), applies inbound events through the same `store.update`
  (idempotent, echo-suppressed), an IndexedDB **`outbox`** (DB_VERSION→3) that queues
  while offline and flushes on reconnect, and snapshot **adopt** (on join) / **union-merge**
  (in-session). Gated on `MULTIPLAYER_URL` (falls back to `OVERPASS_PROXY_URL`); inert
  when unconfigured.
- **UI:** ☰ menu ▸ 📡 Multiplayer — create/join by code, pick role (hider/seeker),
  presence + connection status, leave.
- **GUIDE.md §2 amended:** "no server, no account" → "no account, optional relay"
  (IndexedDB is still each device's source of truth; the app is unchanged with no
  backend configured).
- **Verified:** two headless clients (relay + snapshot + presence + cross-device event
  delivery); a real browser client connecting to the live relay, applying inbound
  events, suppressing echoes, and streaming its own `zone.add`/`step.add` edits to a
  joined Node peer.

## Phase 12 — Presentation polish
Client-side only; no hosting impact.
- **Multiple map styles.** A Map / Satellite / Dark base-style toggle (Settings,
  device-level, applied live via `applyMapStyle` in [`src/maps.js`](src/maps.js);
  dark style warns under a vector Map ID since that's cloud-styled), plus a
  **🖨 Print / save map (PDF)** menu action that hides the app chrome via a `@media
  print` stylesheet and prints just the shaded map — browser print-to-PDF, no new dep.
- **i18n scaffolding.** cniehaus's no-dependency pattern: [`src/i18n.js`](src/i18n.js)
  `t()`/`tf()` helpers over plain [`src/langs/en.js`](src/langs/en.js) dictionaries.
  English only for now (the UI isn't routed through it yet — a future need), so adding
  a language is a drop-in rather than a refactor.
- **PWA update UX.** A new build's service worker now WAITS and the app shows a visible
  "New version available — Reload" banner instead of a silent background swap; clicking
  Reload skip-waits and reloads once, so players never unknowingly run a stale cached
  version mid-game.

## Phase 11 — Question timers + optional "computed truth" check
Client-side only; both opt-in via Settings, both default off.
- **Soft per-question timer** ([`src/timer.js`](src/timer.js)). An optional countdown
  (Off / 1 / 2 / 5 min) shown when a question is asked, plus a manual "Start timer"
  button in the Questions panel. Deliberately soft — it never blocks adding another
  question (JLTG is planning-oriented / single-device).
- **Optional computed-truth check.** Manual answers are still the only answers — this
  never overrides them. When the hider's centre is set, it reuses each step's existing
  elimination geometry: if the hider's point falls inside the region a step would
  eliminate, the answer is flagged (a toast on add + a ⚠ in the Questions list) as
  "removes the hider's location — double-check it". Steps with no computable region
  report "unavailable" and are not flagged (gelbh's "truth unavailable" fallback).

## Phase 10 — Optional Overpass fallback for Places search (Render Web Service)
A mitigation against Places API cost/quota risk — a FALLBACK, not a replacement for
the Google Maps engine. First phase to use Render's Web Service tier.
- **Overpass proxy backend** ([`server.js`](server.js), Express): a `/overpass`
  route that broadens OSM tag matching per category, tries multiple public Overpass
  endpoints with retry/backoff server-side, and returns a normalized `{name,lat,lng}`
  list. Deployed as a **separate** Render Web Service ([`render.yaml`](render.yaml) +
  [`package.json`](package.json)); the Static Site is unchanged. Verified end-to-end
  (returns real OSM data for a Singapore bbox).
- **Client fallback ladder** (`searchCategoryResilient` in [`src/places.js`](src/places.js)):
  Google Places first; on failure / quota-exhaustion / a thin result, fall back to
  Overpass over the game-area bbox (broadened tags), then keep the larger set. A
  per-category, per-area decision, gated on a configured `OVERPASS_PROXY_URL` (env →
  `config.js`); with none set it's a no-op (Google-only). Wired into Matching (nearest),
  Measuring (points) and Tentacles (auto-find). Thin-result messages now also point at
  the Phase 9 Custom library as the long-term local fix.

## Phase 9 — Admin-division tool + reusable custom categories
Extends the Matching tool family and the reusable-library model. No hosting impact.
- **Admin-division comparison (🗺 Admin check).** A new diagnostic in the Questions
  panel: tap two points, reverse-geocode both, and compare their administrative
  divisions level by level (neighbourhood → city → county → state → country), each
  marked ✓ same / ✗ different / – unknown. Helps reason about an admin-division
  question; the admin1–4 Matching cards still do the actual elimination. (cniehaus's
  admin-division checker.)
- **Reusable custom categories + pins (Custom library).** A new device-level library
  (☰ menu ▸ Custom library, IndexedDB `categories` + `pins` stores) of user-defined
  Places categories and named pins, reusable across games like the zone library.
  Custom categories appear in Matching (nearest), Measuring (points) and Tentacles
  (fixed radius); saved pins can seed the "place my own" flows. This is the long-term
  fix for regional data gaps — patch a missing category once and reuse it every game.
  (gelbh's SessionCustomCategory / SessionCustomLocationPin.)

## Phase 8 — Data resilience, validation & Render config migration
Hardens the local-only architecture and moves hosted config to Render's env-var
model. No new user-facing features.
- **Validate on read.** `validateGame` (now stricter — it also checks zone/step
  shape and known tools) runs whenever a game is read back from IndexedDB, not only
  on import. A corrupted last-open record starts a fresh game (the bad record is kept
  for recovery, not deleted); opening a corrupted saved game surfaces a clear error.
- **Contain renderer failures.** `computeActiveArea` and the per-step guide render
  are wrapped so one malformed geometry is skipped rather than blanking the map, and
  `Layers.render()` has a top-level guard that shows a dismissible, recoverable error
  banner ("try disabling that question") instead of throwing uncaught.
- **Config → Render environment variables.** [`render.yaml`](render.yaml) deploys the
  app as a Render **Static Site**; [`scripts/build-config.js`](scripts/build-config.js)
  generates `config.js` from `GOOGLE_MAPS_API_KEY` (and optional `MAP_ID`, center,
  zoom) at build time, removing the manual "copy config.example.js" step. Local dev is
  unchanged (git-ignored `config.js`; the script refuses to clobber it). Dashboard
  walkthrough + Google Cloud referrer step added to the README.
- **Boundary precision verified.** Confirmed Google's Geocoding API returns only a
  viewport rectangle; exact administrative outlines come from Data-driven styling with
  a vector Map ID (already implemented). Documented in `GUIDE.md` §4.

## Post-roadmap enhancements
- **Question bank → real Jet Lag cards (Tentacles first).** The question tools are
  being rebuilt to offer *only* the cards from the game (`docs/jetlag_questions.md`),
  each with its true mechanics. **Tentacles** now uses the fixed-radius cards — 2 km
  (museums, libraries, movie theaters, hospitals) and 25 km (metro lines, zoos,
  aquariums, amusement parks) — sourced automatically from Google Places (metro
  lines via metro stations). Candidate places are distance-bounded to those whose
  radius can reach the play area. Answers: the closest in-range place (keep its
  Voronoi cell ∩ its radius circle) or **none in range** (eliminate the union of all
  radius circles — a radar-"outside" over every listed place). Matching/Measuring
  rebuilds to follow.
- **Region boundaries → official Google reference overlay.** Replaced the OpenStreetMap
  (Nominatim) named-region zones with an **official-Google-boundary reference layer**: search
  a place ("Singapore", "Switzerland") and its real administrative boundary is overlaid on the
  map for reference only — it is **not** added as a zone, so you hand-plot your own points along
  it with Draw, and searching another place leaves drawn zones untouched. Exact boundaries use
  Google **Data-driven styling** (set a vector Map ID in Settings); without a Map ID it falls
  back to the geocoder's official viewport rectangle. Removed `src/regions.js` and the Nominatim
  dependency.
- **Removed auto-answer entirely.** The hider feature is now purely a **Hiding zone**:
  set a centre point + radius and everything outside the radius is shaded (dark mask +
  purple boundary circle, clipped to the game area). No more placing the hider's location
  to auto-fill question answers — all questions are answered manually. Removed the
  `autoAnswer` engine, the per-tool "auto-answer from lock" checkbox, and related wording.
  The centre + radius persist per game and save immediately.
- **Draggable measure points**: the two Measure points are now draggable; distance +
  travel time recompute live as you drag, with a persistent on-map readout.
- **Named-region zones**: search a place ("Singapore", "Switzerland") and add its
  real boundary as a zone via OpenStreetMap Nominatim (falls back to a bounding box when
  OSM has no polygon). Add several to combine them into the play area (`turf.union`).
- **"Questions" terminology**: the eliminations/layers panel is now "Questions"; each
  question can be given a custom name (✏️), shown in the list instead of the auto label.
- **Directions tab**: a dedicated tool to route from current location / a tapped point /
  a searched place to a destination, with transit / walking / driving modes.

## Phase 6 — History & polish
- **Game history browser** (`src/games.js`): list saved games with date / zone / step
  summary; open, rename, duplicate, and delete.
- **Export / import** a game as JSON (file download or paste); import opens the game.
- **Settings**: distance mode (straight-line / walking / transit) drives Measure travel
  time and directions; units (metric / imperial) drive distance readouts.
- Top-bar **☰ menu** hosts new game, history, rename, duplicate, export, import, settings.
- Fixed `exportGame` to use the in-memory current game so a fresh export never lags the
  debounced autosave.

## Phase 5 — Hider lock & auto-answer
- **Hider lock** (`src/hider.js`): pin the hider's true location by tapping the map or
  using current location; rendered as an "H" marker and persisted with the game.
- **Auto-answer** (`autoAnswer` in `src/tools.js`): when locked, each tool computes its
  own correct answer — radar inside/outside, thermometer hotter/colder, nearest Voronoi
  cell for Matching/Tentacles, and within/beyond for Measuring.
- Each tool's input sheet shows a "🔒 Auto-answer from hider lock" checkbox (on by default
  when a lock is set) that overrides the manual answer at commit time.
- Toolbar made horizontally scrollable to fit the added Lock tool on narrow phones.

## Phase 4 — Measuring
- **Measuring** tool: `turf.buffer` a reference feature by a distance, then keep the
  "within" side (inside the buffer) or the "beyond" side (outside). Verified the two
  sides are complementary (sum to the game area).
- Reference can be a **Places category** (buffered point set / MultiPoint) or a
  **bundled linear feature**.
- Ships approximate Mumbai west coastline + Western Railway polylines
  (`src/data/linear.js`), clearly marked as non-survey-accurate and editable.
- Reference geometry (and Places feature set) is stored in the step for deterministic
  recomputation.

## Phase 3 — Voronoi tools
- **Matching** ("is your nearest X the same as mine?") and **Tentacles** ("which of these
  are you closest to?") on a shared `turf.voronoi` engine (`voronoiCells` in `src/tools.js`).
- Voronoi computed over a padded bbox covering features + game area, then each cell clipped
  to the game area; verified as an exact partition (all cells sum to the game area).
- **Places API** category search (`src/places.js`, classic `PlacesService.nearbySearch`):
  railway/metro/bus/park/hospital/school/worship/attraction/mall/restaurant + free keyword.
- The fetched feature set is stored in the step's inputs so the partition recomputes
  deterministically later (Places results are not stable over time).
- Matching keeps or shades the selected feature's cell (Yes/No); Tentacles keeps the
  revealed-closest feature's cell.

## Phase 2 — Core tools
- **Radar** (centre + radius circle): "Yes/inside" keeps the circle, "No/outside" removes it.
- **Thermometer** (perpendicular bisector of A→B): hotter keeps B's half, colder keeps A's.
  Built in a local equirectangular projection (lng scaled by cos·lat) so the bisector is
  correctly equidistant at city scale — great-circle `destination` over ~200 km displaced
  the line by roughly the size of the play area and gave wrong results.
- **Elimination engine** (`src/tools.js`): pure functions compute each step's eliminated
  region from its inputs; `activeArea = gameArea − union(enabled eliminations)`, computed
  order-independently so toggling any layer recomputes correctly.
- **Layers** (`src/layers.js`): red shaded overlays per enabled step + a green active-area
  outline, tool guides (circle outline, A→B line, endpoint markers), and a bottom-sheet
  panel with map point-picking for tool inputs.
- **Backtracking**: undo / redo (walks enabled steps) and per-layer enable/disable toggle.

## Phase 1 — Zones & map basics
- Custom **draw-zone** tool (tap to add vertices → Finish). *Deviation from guide:* the
  Maps JS `DrawingManager` was removed in API v3.65, so drawing is implemented directly
  with map clicks + a live polygon preview instead of the Drawing library.
- **Import zones** from GeoJSON (Polygon / Feature / FeatureCollection) or a pasted
  coordinate list (`lat,lng` per line).
- Reusable **zone library** (IndexedDB `zones` store); add saved zones into any game.
- **Game area** assembled via `turf.union` of all zones; rendered as a gold boundary,
  recomputed whenever zones change; zones persist and restore across reloads.
- Native map features: **transit layer** toggle, **Directions here** (transit/walking)
  on long-press, **distance between two taps** (straight-line + walking time).
- Turf.js vendored locally (`vendor/turf.min.js`) instead of a runtime CDN dependency.
- Service worker switched to **network-first** for same-origin assets so online devices
  always receive the latest build while remaining offline-capable.

## Phase 0 — Foundations
- App skeleton; Google Maps JS API loader (maps, places, geometry, drawing, marker,
  visualization).
- PWA: web manifest, offline service worker, home-screen install; radar app icons.
- IndexedDB wrapper (`jltg` DB) + Game/Zone/Step data model + debounced autosave store.
- Runtime API-key entry: key from git-ignored `config.js` locally, or entered once on
  a device (stored in `localStorage`) for the hosted/phone build.
- Deployed via GitHub Pages for on-device testing.
