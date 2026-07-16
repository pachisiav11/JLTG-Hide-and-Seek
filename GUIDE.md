# Jet Lag Hide & Seek — Map Companion
### Project Guide & Roadmap

> A mobile web app (PWA) that reproduces a full Google Map — with transit times,
> distances, and place search — and layers on the deductive **elimination tools**
> needed to run a game of *Jet Lag: The Game*'s Hide and Seek.

---

## 1. Vision

Hide and Seek is a deduction game: one **hider** hides somewhere inside an agreed
zone; the **seekers** ask questions whose answers let them **shade out** parts of
the map until only the hiding area remains. This app is the seekers' (and hider's)
digital board — it holds the real Google Map so you keep every navigation feature
you'd want in the field (transit schedules, walking/transit times, station search),
and adds drawing tools that translate each question type into a coloured region on
the map.

**Design pillars**
1. **Full Google Maps parity** — never lose transit timings, distances, or search.
2. **One tap = one elimination** — every question type produces a toggleable shaded region.
3. **Never lose a game** — locking, backtracking, and permanent local history are first-class.
4. **Phone-first** — installable to the home screen, thumb-reachable controls.

---

## 2. Platform Decision (locked)

| Decision | Choice | Why |
|---|---|---|
| Surface | **Mobile web app + PWA** | Most complete Maps overlay surface; testable during build; opens as a URL and "Add to Home Screen" behaves like an app. A native-app overlay *on top of* Google Maps is not possible — Google exposes no such hook. |
| Map engine | **Google Maps JavaScript API** | Native custom overlays (circles/polygons), Transit layer, tilt/zoom. |
| Geometry | **Turf.js** | Voronoi, perpendicular bisectors, buffers, polygon union/intersection/difference — the exact primitives every tool needs. |
| Data provider | **Google Maps Platform (real API key)** | Accurate transit timings & Places (important for Singapore). Stays inside the free tier for personal use. |
| Storage | **IndexedDB (local, on-device)** | Every game stored permanently and re-openable. No account. |

> **Phase 13 amendment (optional live multiplayer).** The original "no server, no
> account" premise is relaxed to **"no account, optional relay."** IndexedDB is still
> each device's source of truth and the app works fully offline/single-device; when a
> backend URL is configured, an **optional** Socket.IO relay (a relay, not a store —
> [MULTIPLAYER_DESIGN.md](MULTIPLAYER_DESIGN.md)) lets devices in a session code share
> zones/questions live. No login is ever required. With no backend configured the app
> is exactly as before.

**Not a native overlay.** The app renders its *own* Google Map. It is not injected
into the stock Maps app. Functionally you keep 100% of Maps features because Google
serves them through APIs (Directions, Distance Matrix, Places, Transit layer).

---

## 3. Tech Stack

- **Language/UI:** HTML + modern JavaScript (ES modules). A light framework
  (vanilla or a small library) — no heavy build tooling required.
- **Map:** Google Maps JavaScript API
  - Libraries loaded: `maps`, `places`, `geometry`, `drawing`, `marker`, `visualization`
- **Services (web APIs):**
  - **Directions API** — routing, `mode=transit` for schedules/timings, `mode=walking`.
  - **Distance Matrix API** — many-to-many travel times/distances (Measuring, comparisons).
  - **Places API** — station/POI search for Matching & Tentacles.
- **Geometry:** [Turf.js](https://turfjs.org/) (`@turf/turf`).
- **Persistence:** IndexedDB (via a small wrapper such as `idb`), plus `localStorage`
  for lightweight settings.
- **PWA:** Web App Manifest + Service Worker (offline shell, home-screen install).

### Google Cloud setup (one-time)
1. Create a Google Cloud project.
2. Enable: **Maps JavaScript API, Directions API, Distance Matrix API, Places API**.
3. Create an **API key**; restrict it to those APIs and (for production) to the app's domain.
4. Add a billing account (card required). Personal use will stay in the free monthly
   tiers — realistically ₹0 — but keep the key restricted so it can't be abused.
5. Store the key in a config file that is **git-ignored**.

---

## 4. The Zone Model

The play area is a **set of named zones** rather than a single boundary. Examples:
`Marina Bay + Chinatown`, `Singapore + Switzerland`.

**Data shape (per game):**
```jsonc
{
  "id": "game_2026-07-02_1",
  "name": "Sunday Singapore run",
  "createdAt": 1751...,
  "zones": [
    { "id": "marina-bay","name": "Marina Bay", "polygon": [[lat,lng], ...] },
    { "id": "chinatown", "name": "Chinatown",  "polygon": [[lat,lng], ...] }
  ],
  "gameArea": "<union of all zone polygons, precomputed with turf.union>",
  "hiderLock": { "locked": false, "point": null, "stationName": null },
  "history": [ /* ordered guess/elimination steps — see §6 */ ],
  "activeArea": "<remaining valid polygon after applying visible eliminations>"
}
```

- Zones can be drawn by hand (custom click-to-draw) **or** imported (GeoJSON / paste coordinates).
  To help hand-drawing, **🌍 Region boundary** overlays a place's official Google boundary
  (Data-driven styling, or an approximate viewport box) as a *reference only* — never a zone.
  - **Boundary precision (verified, Phase 8).** Google's **Geocoding API returns only a
    `viewport`/`bounds` rectangle** for a place, *not* a precise administrative polygon — so
    the rectangle fallback is the best the geocoder alone can do. The **exact** outline comes
    from Google **Data-driven styling** (DDS): with a vector Map ID whose boundary FeatureLayers
    are enabled, `getFeatureLayer(...).style` paints the real administrative polygon
    ([src/boundaries.js](src/boundaries.js) `_highlightFeature`). This is the equivalent of
    cniehaus's exact OSM-relation approach, using Google's own boundary data instead of
    Nominatim. **Takeaway:** exact boundaries require a DDS-enabled Map ID (set in Settings);
    without one, only the approximate box is available — this is a Google API limitation, not a
    code gap, and users trace the reference with ✎ Draw either way.
- `gameArea` = `turf.union(...zones)`; all elimination tools clip against it so nothing
  is ever shaded outside the play area.
- A **zone picker** lets you build a game from a saved library of reusable zones
  (so "Marina Bay" is defined once and reused across games).

---

## 5. The Elimination Tools

Every tool follows the same lifecycle:

1. **Input** — collect the tool's parameters (a point, a radius, two points, a category…).
2. **Compute region** — build a GeoJSON polygon with Turf.js.
3. **Choose side** — for questions with a yes/no answer, pick whether the hider is
   *inside* or *outside*; the app shades the eliminated side.
4. **Render** — draw a **temporary, toggleable** shaded overlay (semi-transparent fill).
5. **Commit** — push the step onto `history`; recompute `activeArea` from all
   *enabled* eliminations.

All shaded regions are **toggle layers**: each can be individually enabled/disabled
without deleting it (so you can compare hypotheses), and disabling one recomputes the
remaining area.

---

### 5.1 Radar — centre + radius circle

- **Input:** a centre point (tap map, search a place, or "use hider lock") + radius (m/km).
- **Question:** "Are you within *r* of this point?"
- **Geometry:** `turf.circle(center, radius)`.
- **Elimination:**
  - Answer **Yes** → hider is inside → eliminate everything *outside* the circle:
    `turf.difference(gameArea, circle)` is the shaded (removed) region; keep the circle ∩ area.
  - Answer **No** → eliminate *inside* the circle: shade the circle.
- **Render:** circle outline + shaded eliminated side.

---

### 5.2 Thermometer — two points, hotter/colder line

- **Input:** point A (start) and point B (end of a short move).
- **Question:** "After moving from A to B, are you hotter (closer) or colder (farther)?"
- **Geometry — perpendicular bisector:** the set of points equidistant from A and B
  is the perpendicular bisector of segment AB. It splits the plane into two half-planes:
  the half nearer A and the half nearer B.
  1. Midpoint `M = turf.midpoint(A, B)`.
  2. Bearing `θ = turf.bearing(A, B)`; the bisector runs along `θ ± 90°`.
  3. Build a long line through `M` in the `θ±90°` direction, then extend it into a
     half-plane polygon covering the map, clip to `gameArea`.
- **Elimination:**
  - **Hotter** (closer to B) → keep the half-plane on B's side; shade A's side.
  - **Colder** → shade B's side.
- **Note:** "distance" here should match the game's rules — straight-line by default,
  optional transit/walking distance via Distance Matrix as an advanced mode.

---

### 5.3 Matching — divide the map by nearest ___

- **Input:** a category (e.g. nearest **railway station**, **park**, **McDonald's**).
- **Question:** "Is your nearest *X* the same as mine?"
- **Geometry — Voronoi:** fetch all features of category *X* in/near the game area via
  Places API. Compute the **Voronoi diagram** of those points (`turf.voronoi`) clipped
  to `gameArea`. Each Voronoi cell = the region whose nearest *X* is that specific feature.
- **Elimination:**
  - Identify the hider's cell (the cell containing the hider's nearest *X*).
  - **Match = Yes** → keep that one cell; shade all others.
  - **Match = No** → shade the hider's cell only.
- **Render:** optionally show all cell boundaries faintly so seekers understand the partition.

---

### 5.4 Measuring — distance comparison to a feature type

- **Input:** a distance value (m/km) **and** a reference feature/category
  (e.g. "within 500 m of a coastline", "nearer to a hospital than X").
- **Question (two common forms):**
  - *Threshold:* "Is your nearest *X* within *d*?"
  - *Comparison:* "Is your nearest *X* closer/farther than mine?"
- **Geometry — buffers:**
  1. Get the reference geometry (points, or lines like coastline/railway from Places/GeoJSON).
  2. `buffer = turf.buffer(referenceGeometry, d)` — the set of points within *d* of it.
- **Elimination:**
  - *Threshold Yes* → keep inside the buffer; shade outside.
  - *Threshold No* → shade inside the buffer.
  - *Comparison* → build the buffer at the hider's own measured distance and keep the
    matching side.
- **Difficulty note:** accuracy depends on having good reference geometry. Point
  categories (stations, hospitals) are easy via Places; linear features (coastline,
  rivers, rail lines) have no Places source at all. These were once going to ship as a
  bundled per-zone GeoJSON dataset; that approach is rejected (§5.6) because it only ever
  covered the zones someone had hand-traced. They are hand-drawn today and auto-sourced
  from Overpass worldwide by §5.6.

---

### 5.5 Tentacles — "of the ___ within my reach, which are you closest to?"

Implemented by the **seeker-radius model** (Phase 18). The card carries a FIXED radius
centred on the **seeker**, and the question is only about places inside that reach — it is
not an enumeration of the whole play area.

- **Cards** (`src/data/questions.js`), two tiers by feature density:
  - **2 km** — Museums, Libraries, Movie Theaters, Hospitals.
  - **25 km** — Metro Lines *(sourced as metro stations — see §F1 of `REVIEW_FINDINGS.md`)*,
    Zoos, Aquariums, Amusement Parks.
- **Input:** the seeker drops their own centre, the app finds that category within the
  card's radius, and the seeker confirms the candidate set. The hider answers with **one
  candidate** or **"none — a miss"**.
- **Geometry** (`tentacles()` in `src/tools.js`):
  - **Miss** (`{ none: true }`) — the hider is outside the seeker's reach, so **eliminate
    the inside of the seeker's circle**: `seekerCircle ∩ gameArea`.
  - **Hit** (`{ featureIndex }`) — the hider is within reach AND closest to P, so the
    surviving region is `cell(P) ∩ seekerCircle`; everything else is eliminated. With a
    single candidate the whole area is P's cell, so it reduces to `area ∩ seekerCircle`.
  - `cell(P)` is the Voronoi cell over the candidate points (same engine as Matching),
    clipped to `gameArea` by `voronoiCells`.
- **Candidate sourcing:** bounded to the card's radius around the seeker, NOT the whole
  board (see §B6 of `REVIEW_FINDINGS.md` — a 2 km tentacle must not query a 300 km board).
  Candidates are **not** filtered to inside `gameArea`: a place just outside the boundary
  can genuinely be a hider's nearest, and dropping it inflates the surviving cells (§A3).
- **Render:** the seeker circle plus the cell outlines, so the partition is legible.

> Matching and Tentacles share one Voronoi engine. They differ in the answer contract:
> Matching answers `{ featureIndex, keep }` (same/different), Tentacles answers
> `{ featureIndex }` or `{ none: true }`. They are NOT interchangeable — reusing Matching's
> shape for a Tentacles answer eliminated the hider's own cell (§A4).

**Legacy note:** steps recorded before Phase 18 have no `center`. A `radius`-bearing legacy
step uses per-POI circles (a miss eliminates their union); a legacy step with no radius at
all is a plain nearest-cell partition. Both paths are kept so old games still recompute.

---

### 5.6 Linear & boundary features — worldwide auto-sourcing (method)

Cards needing a **line** (Coastline, High Speed Train Line, International Border,
Admin. Division Borders, Transit Line) have no Google source: the Maps JS API exposes
no queryable line geometry, and `TransitLayer` is raster tiles with nothing to query.
These are auto-sourced from **OpenStreetMap via the existing Overpass proxy**.

**Principle: no city may be privileged.** Nothing here is regional. Bundled per-city
geometry (the old `src/data/linear.js`, Mumbai-only, hand-traced) is rejected for this
reason — it made one city better than every other. Auto-sourcing is worldwide or it
doesn't ship.

**Principle: fetch real geometry, never infer it.** Do not synthesise a line by joining
stations. "Nearest station" ≠ "nearest line" wherever station spacing exceeds line
spacing — exactly the dense metro cores where these cards get played (see §F1 of
`REVIEW_FINDINGS.md`). OSM has the surveyed geometry; use it.

**Principle: clip, don't tag-filter.** Restrict geometry to the play-area bbox rather
than filtering by tag. Tag conventions vary by country, so a filter that looks correct
locally silently drops features elsewhere. Clipping is tag-independent, and an express
line contributes only the segment inside the board — which is semantically right.

#### 5.6.1 Admin division levels — derive, never hardcode

OSM tags boundaries `boundary=administrative` + `admin_level` (2–10). The mapping from
level → "1st/2nd admin division" is **not fixed**, so the app derives it per play area.

**Query** (verified — returns the areas *containing* a point; an `around:` query answers
a different question and omits the enclosing country/state entirely):

```
[out:json][timeout:90];
is_in(LAT,LON)->.a;
area.a["boundary"="administrative"];
out tags;
```

**Derivation:**
1. Run the query at the play-area centre.
2. **Discard level 2** (country) **and level 3.**
3. Sort the remainder by `admin_level` ascending.
4. Ordinal position ⇒ division: 1st = first entry, 2nd = second, and so on.
5. **Show the returned name on the card** ("2nd Admin. Division: Cook County"), so the
   seeker sees what they are actually being asked about.
6. Several relations may share one level — handle duplicates, don't assume uniqueness.

**Evidence** (measured 2026-07-15; 42 samples = 14 countries × 3 cities, each capital
paired with two ordinary cities to expose capital bias; raw data in the spike cache):

- **Level 4 = 1st division in 14/14 countries** — Maharashtra, Illinois, Bavaria, Osaka
  Prefecture, New South Wales, Wales. This one assumption is safe.
- **Step 2 (discard level 3) is load-bearing.** Without it the derivation breaks in 9/42
  samples: Brazil's level 3 is a macro-region (*North Region*), France's is *Metropolitan
  France*, and the Netherlands' level 3 is **"Netherlands" — the country repeated**. With
  it, the derivation holds 42/42.
- **The 2nd division has no fixed level, not even per country.** Japan uses **7** (levels
  5 and 6 do not exist); the Netherlands uses **8** (no 5/6/7); the USA, Italy, South
  Africa, South Korea and Australia use 6; India uses 5. Worse, it varies *within* a
  country: France is 5 in Lyon (Rhône) but 6 in Toulouse (Haute-Garonne); the UK is 5 in
  England (Greater Manchester) but 6 in Wales (Cardiff); Canada is 5 in Halifax but 6 in
  Calgary; Germany is 5 in Munich/Cologne but **Berlin has none and jumps 4 → 9**.

> **A per-country lookup table cannot work.** France, the UK, Canada and Germany each
> disagree with *themselves*. Derive from the hierarchy at the play area, per game.

Caveat, recorded honestly: ordinal derivation returns whatever OSM ranks next, which is
occasionally a statistical rather than administrative region (Canada level 5 = *Golden
Horseshoe*; Brazil level 5 = *Região Geográfica Intermediária*). The boundary is real and
consistent for both players, so the question stays well-posed — step 5's visible name is
what keeps it honest, and is not optional.

#### 5.6.2 Coastline

```
[out:json][timeout:90];
way["natural"="coastline"](BBOX);
out geom;
```

Measured (2026-07-15): Mumbai 90 ways / 5152 vertices, Cape Town 107 / 4011, Sydney
59 / 2188. Returned as **many open fragments, not one line** — and mostly unnamed (82 of
90 in Mumbai). They do chain end-to-end (88 of 90 ways share an endpoint), so stitching is
*possible* — but **not required**: buffer the fragments as a `MultiLineString` and turf
handles it. Payload after slimming to 5 decimal places is 48–102 KB, fine for a phone.

#### 5.6.3 Rail / transit lines

Query **route relations**, not `railway=rail` (which returns every siding, yard and
freight spur). Keep `name` in the payload even though the map draws no labels — the
Matching `nearestLine` card consumes named geometry in exactly that shape. See §G1 of
`REVIEW_FINDINGS.md` for the measured Mumbai numbers.

**Streets stay hand-drawn.** Roads have no curated route-relation equivalent, so the
"Street or Path" card keeps its manual trace. Auto-sourcing is additive — the hand-drawn
path remains the floor that works everywhere.

#### 5.6.4 Overpass reliability (endpoint order is wrong today)

Measured over 61 live attempts: **22 succeeded (36%)** — a ~64% failure rate, worse than
the ~50% previously recorded. Per endpoint:

| endpoint | success |
|---|---|
| `overpass-api.de` | 7/25 (28%) |
| `overpass.kumi.systems` | **0/18 (0%)** |
| `maps.mail.ru/osm/tools/overpass` | **15/18 (83%)** |

`server.js` tries these **in exactly the wrong order** — the 0%-success endpoint is tried
second and the 83% endpoint last. Reorder it. Also required (per D3): sniff the body
before parsing (Overpass returns HTTP **200** with an HTML error body when busy, which
`resp.json()` reports as a bogus parse error), treat HTTP **400** as fatal rather than
retrying it, and set a client-side fetch timeout — `fetch` has no default, so a stalled
endpoint hangs forever while appearing to work.

**Still unrun:** the Overpass-side clip (`relation(BBOX)->.r; way(r)(BBOX); out geom;`).
If it works it pushes clipping server-side and avoids pulling 8.3 MB into the proxy; if
not, clip in `normalize()`. Spike this before building §G1's render.

---

## 6. Game-Control Features

### 6.1 Hider lock
- Toggle to **lock a point/station as the hider's true centre**.
- When locked, tools can auto-answer their own questions (great for the hider's device,
  or for testing): e.g. Radar knows if the lock is inside the circle; Matching knows
  which Voronoi cell the lock sits in.
- Lock stores `{ point, stationName }` and persists with the game.

### 6.2 Backtracking (within a game)
- `history` is an ordered stack of steps. Each step records: tool, inputs, computed
  region (or a deterministic recipe to recompute it), chosen side/answer, and enabled flag.
- **Undo/redo** walks the stack; **toggle** enables/disables any past step without
  removing it. `activeArea` is always recomputed as
  `gameArea − (union of all enabled eliminations)`.
- Because steps store their inputs, regions can be recomputed deterministically after
  load (no need to serialize huge polygons if inputs suffice).

### 6.3 Local game storage (permanent, re-openable)
- **IndexedDB** database `jltg`, object store `games` keyed by `id`.
- Save on every committed step (autosave) + explicit "Save / Rename".
- A **history browser** screen lists all past games (name, date, zone summary) and
  reopens any of them fully — zones, lock, history, active area restored.
- Export/import a game as JSON for backup or sharing between your own devices.

---

## 7. Screens / UI

1. **Map screen (home)** — the Google Map fullscreen; floating toolbar of the 5 tools;
   layer list (toggle each elimination); bottom sheet for the active tool's inputs.
2. **Zone builder** — draw/import zones, name them, assemble a game area.
3. **Tool sheets** — one bottom-sheet form per tool (Radar radius, Thermometer A/B, etc.).
4. **Layers panel** — list of eliminations with enable/disable, reorder, delete.
5. **Game history** — saved games list, open/rename/duplicate/export.
6. **Settings** — API key status, distance mode (straight-line vs transit), units.

**Native Maps features surfaced in-app:** long-press a point → "Directions here"
(transit/walking via Directions API), "Nearby stations" (Places), live Transit layer
toggle, distance readout between two taps (Distance Matrix).

---

## 8. Data Model (summary)

```jsonc
Game {
  id, name, createdAt, updatedAt,
  zones: Zone[],                 // reusable named polygons
  gameArea: Polygon,             // turf.union(zones)
  hiderLock: { locked, point, stationName },
  history: Step[],               // ordered, each toggleable
  settings: { distanceMode, units }
}

Step {
  id, tool: "radar"|"thermometer"|"matching"|"measuring"|"tentacles",
  inputs: { ... },               // enough to recompute the region
  answer: { ... },               // yes/no or chosen feature
  enabled: boolean,
  createdAt
}
```

`activeArea` is derived (not stored authoritatively): recompute from `gameArea` and
the enabled steps whenever history changes.

---

## 9. Workflow & Repository

**Build strictly in phases.** Complete one phase fully before starting the next —
implement, verify it runs, then ship it. Do not jump ahead or bundle phases together.

**Repository:** `JLTG-Hide-and-Seek` — a **new public GitHub repo**.

**End-of-phase ritual (every phase, no exceptions):**
1. Finish and verify the phase's deliverables.
2. Update this guide / a `CHANGELOG` if scope shifted.
3. `git add` + commit with a message like `Phase N: <summary>`.
4. **Push to the public `JLTG-Hide-and-Seek` repo.**
5. Only then begin the next phase.

> The repo is created during **Phase 0** and pushed to at the end of every phase
> thereafter, so `main` always reflects the last completed, working phase.
> Keep `config`/API keys **out of git** (`.gitignore`) — the repo is public.

---

## 10. Build Roadmap (phases)

Each phase ends with the **end-of-phase ritual (§9): commit + push to the public repo.**

**Phase 0 — Foundations**
- Google Cloud project + key; enable the 4 APIs.
- App skeleton, Maps JS API loading, PWA manifest + service worker, home-screen install.
- IndexedDB wrapper + Game data model + autosave.
- **Create the public `JLTG-Hide-and-Seek` repo, first commit, push.**

**Phase 1 — Zones & map basics**
- Draw/import zones, save to a zone library, assemble a game area (`turf.union`).
- Surface native features: transit layer toggle, directions-here, distance-between-taps.
- **Commit + push.**

**Phase 2 — Core tools (easy geometry)**
- **Radar** (circle) and **Thermometer** (perpendicular bisector).
- Layer system: shaded toggleable regions + `activeArea` recomputation.
- Undo/redo + toggle (backtracking).
- **Commit + push.**

**Phase 3 — Voronoi tools**
- **Matching** and **Tentacles** on a shared `turf.voronoi` engine.
- Places API integration for category feature sets.
- **Commit + push.**

**Phase 4 — Measuring**
- Buffer-based threshold + comparison.
- ~~Bundle GeoJSON for linear features (coastline/rail) for the supported zones.~~
  Shipped as `src/data/linear.js` (Mumbai only, hand-traced), never wired to any code path,
  deleted 2026-07-16. Superseded by §5.6: source these from Overpass worldwide.
- **Commit + push.**

**Phase 5 — Hider lock & auto-answer**
- Lock a point/station; auto-evaluate questions against it.
- **Commit + push.**

**Phase 6 — History & polish**
- Full game-history browser, export/import, rename/duplicate.
- Distance-mode setting (straight-line vs transit), units, UI polish, offline shell.
- **Commit + push.**

---

## 11. Open Questions / To Decide Later

- **Distance semantics per rule:** which questions use straight-line vs transit/walking
  distance? (Configurable; defaults set in Phase 2.)
- **Linear-feature data:** source of coastline/rail GeoJSON for Measuring in each zone.
- **Ruleset variant:** which Jet Lag season's card/curse rules (if any) to model later.
- **Two-device play (future):** current scope is single-device; a sync layer could be a
  later phase if hider and seekers want separate live views.

---

## 12. Cost & Keys (reality check)

- Personal use (a few players, occasional games) sits well inside Google's monthly free
  tiers for Maps/Directions/Distance Matrix/Places.
- Keep the API key **restricted** (by API + referrer/domain) and **out of git**.
- No server and no accounts: everything else is local to the device.
