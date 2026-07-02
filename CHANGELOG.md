# Changelog

Built phase-by-phase per [`GUIDE.md`](GUIDE.md). Each entry is a completed, pushed phase.

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
