# Changelog

Built phase-by-phase per [`GUIDE.md`](GUIDE.md). Each entry is a completed, pushed phase.

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
