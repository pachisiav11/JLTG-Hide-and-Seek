# Changelog

Built phase-by-phase per [`GUIDE.md`](GUIDE.md). Each entry is a completed, pushed phase.

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
