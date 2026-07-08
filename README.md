# JLTG — Hide & Seek Map Companion

A mobile web app (PWA) that renders a full Google Map and layers on the deductive
**elimination tools** needed to run a game of *Jet Lag: The Game*'s Hide and Seek.

See [`GUIDE.md`](GUIDE.md) for the full vision, data model, and phased roadmap.
See [`IMPROVEMENTS.md`](IMPROVEMENTS.md) for candidate Phase 7+ ideas drawn from
competitive analysis of other Jet Lag map companions.

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
- **Phase 4 — Measuring** ✅
  - Buffer a reference feature by a distance; keep the "within" or "beyond" side.
  - Reference can be a Places category (point set) or a bundled linear feature.
  - Ships approximate Mumbai coastline + Western Railway GeoJSON (`src/data/linear.js`).
- **Phase 5 — Hiding zone** ✅
  - Set the hider's zone centre (tap or current location) and a per-game radius;
    everything outside the radius is shaded out. Persists with the game.
  - (Auto-answer was later removed — all questions are answered manually.)
- **Phase 6 — History & polish** ✅
  - Game history browser (open / rename / duplicate / delete), export & import as JSON.
  - Settings: distance mode (straight-line / walking / transit) and units (metric / imperial).
  - Top-bar menu; offline app shell via the service worker.

**All roadmap phases (0–6) are complete.**

### Post-launch improvements (Phase 7+, see [`IMPROVEMENTS.md`](IMPROVEMENTS.md))

- **Phase 7 — Guide-rendering & interaction polish** ✅
  - Per-step guide colours (two same-tool questions are now distinguishable).
  - Draggable Radar centre + Thermometer A/B anchors (drag to correct a mis-tap).
  - Colour-blind-safe palette toggle (Settings; instant, persisted).
  - Suggested game-area size tier (Small / Medium / Large) on zone assembly.
- **Phase 8 — Data resilience, validation & Render config** ✅
  - Validate games on read from IndexedDB (not just import); corrupt records surface
    a clear error instead of throwing inside the renderer.
  - Contain renderer failures: a bad step is skipped and a recoverable banner shown,
    never a blank map or uncaught throw.
  - Config → Render env vars: [`render.yaml`](render.yaml) +
    [`scripts/build-config.js`](scripts/build-config.js) generate `config.js` from
    `GOOGLE_MAPS_API_KEY` at build time (see **Deploy to Render** above).
  - Verified boundary precision: exact outlines need a DDS Map ID (Google Geocoding
    returns only a viewport box) — documented in `GUIDE.md` §4.

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

## Deploy to Render (static site)

Hosting target is **Render** (default `*.onrender.com` subdomain — no custom domain).
The app deploys as a **Static Site** (no backend). Instead of committing `config.js`,
the Maps key is injected from an environment variable at build time by
[`scripts/build-config.js`](scripts/build-config.js) (wired up in
[`render.yaml`](render.yaml)). Local dev is unchanged — keep your git-ignored
`config.js` and never run the build script locally.

**Dashboard steps (one-time):**

1. **Create the Static Site.** In the Render dashboard: **New ▸ Static Site**, connect
   this GitHub repo (`JLTG-Hide-and-Seek`), branch `main`.
   - **Build command:** `node scripts/build-config.js`
   - **Publish directory:** `.` (the repo root)
   - (Or use **New ▸ Blueprint** and let it read [`render.yaml`](render.yaml).)
2. **Add the key as an environment variable.** In the site's **Environment** tab, add
   `GOOGLE_MAPS_API_KEY` = *your key*. Optionally add `MAP_ID` (vector Map ID for exact
   DDS region boundaries) and `DEFAULT_CENTER_LAT` / `DEFAULT_CENTER_LNG` / `DEFAULT_ZOOM`.
   These are **not** in git.
3. **Confirm the build reads it.** After the first deploy, open the live URL and check
   the map loads. In the build log you should see
   `[build-config] wrote …/config.js (key present, …)`. If it says `key EMPTY`, the env
   var isn't set. (You can also verify locally:
   `GOOGLE_MAPS_API_KEY=… FORCE_CONFIG=1 node scripts/build-config.js` — then discard the
   generated `config.js`.)
4. **Restrict the key in Google Cloud.** In **APIs & Services ▸ Credentials ▸ your key ▸
   Application restrictions ▸ HTTP referrers**, add your Render subdomain, e.g.
   `https://jltg-hide-and-seek.onrender.com/*` (and keep the 4 API restrictions).
   **Without this, Maps requests are silently rejected in production even though local
   dev still works.**

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
