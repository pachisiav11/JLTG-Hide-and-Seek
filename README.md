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
  - **🚄 Rail** draws real rail geometry from OpenStreetMap via the Overpass proxy, worldwide.
    Google's transit layer is raster tiles from its own feed inventory — it takes no options and
    you cannot add an agency — so in Mumbai it draws the Metro but not the Western / Central /
    Harbour locals, which are the lines that decide the game. This draws them. Needs
    `OVERPASS_PROXY_URL`; cached per board in IndexedDB, so it survives going offline mid-game.
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
  - Reference can be a Places category (point set) or a hand-drawn line/region.
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
- **Phase 9 — Admin-division tool + reusable custom categories** ✅
  - 🗺 Admin check: tap two points, compare admin divisions level by level (✓/✗/–).
  - Custom library (☰ menu): reusable custom Places categories (in Matching /
    Measuring / Tentacles) and saved pins (seed the "place my own" flows).
- **Phase 10 — Optional Overpass fallback (Render Web Service)** ✅
  - `server.js` Overpass proxy (multi-endpoint retry/backoff, broadened OSM tags),
    deployed as a **separate** Render Web Service (`render.yaml`, `package.json`).
  - Client falls back Google → Overpass on failure / thin results, gated on
    `OVERPASS_PROXY_URL` (unset = Google-only). See **Backend (optional)** below.
- **Phase 11 — Question timers + optional computed-truth check** ✅
  - Soft per-question timer (Settings; Off / 1 / 2 / 5 min) + manual start.
  - Opt-in computed-truth check: flags (never overrides) a manual answer that would
    eliminate the hider's set location, reusing the step's elimination geometry.
- **Phase 12 — Presentation polish** ✅
  - Map / Satellite / Dark base-style toggle (Settings) + 🖨 Print / save map (PDF).
  - i18n scaffolding (`src/i18n.js` + `src/langs/en.js`; English only for now).
  - PWA "New version available — Reload" banner instead of a silent SW swap.
- **Phase 13 — Live multiplayer sync** ✅ (v1, review gate overridden)
  - Socket.IO relay in [`server.js`](server.js) (rooms by session code, snapshot cache,
    presence) + client sync engine [`src/sync.js`](src/sync.js) (diff-derived events,
    idempotent apply, offline `outbox`, snapshot adopt/merge). ☰ menu ▸ 📡 Multiplayer
    (create/join by code, hider/seeker role). Gated on `MULTIPLAYER_URL` (falls back to
    `OVERPASS_PROXY_URL`); inert when unconfigured. Verified end-to-end. Design +
    v1 deviations: [`MULTIPLAYER_DESIGN.md`](MULTIPLAYER_DESIGN.md).
- **Phase 14 — Rebuild the Android APK** ✅ (device sanity-check still manual)
  - [`download/JLTG.apk`](download/JLTG.apk) rebuilt + re-signed against the live
    Render URL (`jltg-map-companion.onrender.com`, was GitHub Pages), packageId
    `app.web.jltg.twa`, v1.1.0, apksigner v1/v2/v3 verified. Digital Asset Links at
    [`.well-known/assetlinks.json`](.well-known/assetlinks.json) so it verifies as a
    fullscreen TWA once deployed. New signing key ⇒ **uninstall the old app first**.
    Runbook: [`APK_REBUILD.md`](APK_REBUILD.md).
- **Phase 15 — Unified POI candidate picker** ✅
  - One reusable chooser across Matching-nearest, Tentacles and Measuring-points:
    auto-found candidates as **checkboxes** (tick which count) + **Add by tap** and
    **Add by search** (text-search a place/address → confirm). Saved pins seed as
    unticked candidates. Places `nearbySearch` now paginates (~60, not 20).
- **Phase 16 — Admin-division tracing helper** ✅
  - Drawing an Admin Division (1st–4th) offers a pre-draw sheet to toggle the
    **official boundary** of the division you're in (via Data-Driven Styling) to trace
    over. Only L1/L2/locality exist as DDS FeatureTypes, and rendering needs boundary
    FeatureLayers enabled on the Map ID (the sheet says so + degrades gracefully).

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

### Backend (optional) — Overpass proxy

Phase 10 adds an optional **Overpass proxy** ([`server.js`](server.js)) used only as a
*fallback* for Places-category search when Google Places fails or is quota-exhausted.
The map engine stays Google Maps; this never replaces it. It's a **separate** Render
Web Service — the Static Site above is unaffected, and if you don't deploy it the app
simply uses Google Places only.

- **Run locally:** `npm install` then `npm start` → serves on `:3000`
  (`/health`, `/overpass?category=hospital&bbox=S,W,N,E`). Point the client at it by
  setting `OVERPASS_PROXY_URL` in your `config.js` (e.g. `http://localhost:3000`).
- **Deploy on Render:** the second service in [`render.yaml`](render.yaml)
  (`type: web`, `runtime: node`, `plan: free`, `npm install` / `npm start`). Set its
  `ALLOW_ORIGIN` to your Static Site's `*.onrender.com` URL, then set the Static Site's
  `OVERPASS_PROXY_URL` env var to the backend's URL and redeploy.

The **same** backend also hosts the Phase 13 **multiplayer relay** (`/socket.io`). To
enable live sync, set the Static Site's `MULTIPLAYER_URL` to the backend URL (or just
reuse `OVERPASS_PROXY_URL` — with none set, `MULTIPLAYER_URL` falls back to it). Then
☰ menu ▸ 📡 Multiplayer lets one device create a session and others join by code.

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
