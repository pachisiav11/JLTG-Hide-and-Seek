# JLTG — Hide & Seek Map Companion

A mobile web app (PWA) that renders a full Google Map and layers on the deductive
**elimination tools** needed to run a game of *Jet Lag: The Game*'s Hide and Seek.

See [`GUIDE.md`](GUIDE.md) for the full vision, data model, and phased roadmap.

**Live demo (auto-deploys from `main`):** https://pachisiav11.github.io/JLTG-Hide-and-Seek/
On a new device it asks once for your Maps API key (stored only on that device).

## Status

- **Phase 0 — Foundations** ✅
  - App skeleton + Google Maps JS API loading (maps, places, geometry, drawing, marker, visualization).
  - PWA: web manifest, service worker (offline shell), home-screen install.
  - IndexedDB storage (`jltg` DB) + Game data model + debounced autosave.
- **Phase 1 — Zones & map basics** ✅
  - Draw zones (custom click-to-draw tool) and import zones (GeoJSON or coordinate lists).
  - Reusable zone library; assemble the game area with `turf.union`.
  - Native features: transit-layer toggle, "Directions here" on long-press, distance-between-taps.
- **Phase 2 — Core tools** ✅
  - **Radar** (centre + radius circle) and **Thermometer** (perpendicular bisector).
  - Toggleable shaded elimination layers; `activeArea` recomputed as game area minus enabled eliminations.
  - Backtracking: undo / redo and per-layer enable/disable.
- **Phase 3 — Voronoi tools** ✅
  - **Matching** ("is your nearest X the same?") and **Tentacles** ("which are you closest to?").
  - Shared `turf.voronoi` engine; cells clipped to the game area and drawn as guides.
  - Places API category search (railway/park/hospital/…, plus keyword); feature set stored
    in the step so the partition recomputes deterministically.

## Run it locally

The app must be served over **http(s)** (ES modules, service worker, and the
Maps API referrer check all fail on `file://`).

```bash
# from the repo root — any static server works, e.g.:
npx --yes serve .
# or
python -m http.server 8080
```

Then open the printed URL on your phone or desktop browser.

## Configuration

1. Copy `config.example.js` to `config.js` (git-ignored).
2. Put your Google Maps Platform API key in `GOOGLE_MAPS_API_KEY`.
3. Enable these APIs on the key's Google Cloud project: **Maps JavaScript API,
   Directions API, Distance Matrix API, Places API**.

> The Maps JS key is visible in the browser at runtime. `.gitignore` keeps it out
> of source control, but before hosting publicly you must restrict the key by
> HTTP referrer + the 4 APIs in Google Cloud, or it can be abused.

## Project layout

```
index.html              app shell
manifest.webmanifest    PWA manifest
service-worker.js       offline app-shell cache
config.example.js       template config (copy to git-ignored config.js)
icons/                  app icons (radar theme)
styles/main.css         mobile-first styles
src/
  app.js                bootstrap: config -> store -> map -> PWA
  maps.js               Google Maps loader + base map
  db.js                 IndexedDB wrapper
  model.js              Game / Zone / Step factories + validation
  store.js              current game + autosave + import/export
```
