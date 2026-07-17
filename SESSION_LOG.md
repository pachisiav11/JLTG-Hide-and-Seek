# Session log — issues, decisions and manual tasks

This is an exhaustive record of the `REVIEW_FINDINGS.md` changelist and the follow-up
implementation stretch. It covers every finding acted on, every decision made along the way
(including the ones that reversed a decision from the doc), every silent bug found *during* the
work, and the manual actions still required.

> **Status: the changelist is complete.** 47 commits, 239 passing `node:test` tests (from
> zero), one commit per actionable finding, no new dependencies. Everything is pushed to
> `main`. The two things left are not code — they are Render dashboard actions.

Related docs: [`REVIEW_FINDINGS.md`](REVIEW_FINDINGS.md), [`DEPLOY_BACKEND.md`](DEPLOY_BACKEND.md),
[`README.md`](README.md), [`GUIDE.md`](GUIDE.md).

---

## Table of contents

1. [Manual actions still required](#1-manual-actions-still-required)
2. [Cross-cutting decisions](#2-cross-cutting-decisions)
3. [§A — Silently wrong eliminations](#3-a--silently-wrong-eliminations)
4. [§B — Data completeness](#4-b--data-completeness)
5. [§C — State and persistence](#5-c--state-and-persistence)
6. [§D — Robustness](#6-d--robustness)
7. [§E — Dead code and rendering](#7-e--dead-code-and-rendering)
8. [§F — Transit line data (F1 / F2 / F3 / F4)](#8-f--transit-line-data)
9. [§G — Showing rail lines on the map](#9-g--showing-rail-lines-on-the-map)
10. [Silent bugs found *during* the fixes](#10-silent-bugs-found-during-the-fixes)
11. [Method notes — what worked and what didn't](#11-method-notes--what-worked-and-what-didnt)
12. [Known limitations still open](#12-known-limitations-still-open)

---

## 1. Manual actions still required

**None of these can be done from code.** Until both are done, every Overpass-backed feature
(rail lines, auto-sourced coastline / borders / high-speed rail, the Places fallback) is inert
in production even though the code is deployed and correct.

### 1.1 Redeploy `jltg-backend` on Render (auto-deploy is off, or its deploy failed)

**Symptom (measured 2026-07-17):** `GET https://jltg-backend.onrender.com/health` returns
`{"ok":true}`, and `GET /overpass` returns our own `{"error":"Unknown category \"\"."}` — so
the deployed service *is* this repo's `server.js`. But `GET /overpass/lines` **404s**, ~16
hours after commit `a134b71` added that route, and across several further pushes.

**The check:** `GET /overpass/lines?kind=nope&bbox=1,2,3,4` → **400** means deployed,
**404** means stale.

**What to do:** open the `jltg-backend` service in the Render dashboard, click **Manual
Deploy → Deploy latest commit**. The runbook is [`DEPLOY_BACKEND.md`](DEPLOY_BACKEND.md).

### 1.2 Set `OVERPASS_PROXY_URL` on the Static Site

The deployed `config.js` is generated at build time by `scripts/build-config.js` from
environment variables. The script already emits an `OVERPASS_PROXY_URL:` field — the env var
just isn't set.

**What to do:** in the Static Site (`jltg-map-companion`) **Environment** tab, add
`OVERPASS_PROXY_URL=https://jltg-backend.onrender.com` (origin only, no trailing slash), then
trigger a redeploy. Setting the same value for `MULTIPLAYER_URL` also re-enables the parked
Phase 13 multiplayer relay, but that is out of scope.

### 1.3 Playtest 5 full games

The one item no automated test replaces. §A's theme is that failures are silent — nothing
throws, and a wrong elimination looks exactly like a right one. Vary the board deliberately:

- **City scale** and **country scale** — A2 only bites at country scale.
- **A run that eliminates everything** — A1 / A7.
- **A Tentacles-heavy run** — A4.
- **One on a dense rail network** now that §G / §F1 have landed (Berlin, London, NYC, Paris, or
  Tokyo — the five metros where the Berlin bug was found).

---

## 2. Cross-cutting decisions

Choices made once but relied on by many fixes. Each has a stated reason and a location.

### 2.1 Verification: `node:test`, no new dependencies

**Decision:** every fix ships with tests written in `node:test` and asserted through the
vendored `window.turf` UMD via `test/helpers/turf-env.mjs`. No new `devDependencies`, no
transpile step.

**Why:** the app itself has no build step; keeping tests dependency-free preserves that.
`node --test` was available from Node 18+ and this repo's `engines.node >= 18`.

**Location:** `test/*.test.mjs`, `test/helpers/turf-env.mjs`.

### 2.2 One commit per finding, pushed immediately

**Decision:** each finding gets its own commit, message states the *why* not just the *what*,
and each commit is pushed to `main` before the next starts.

**Why:** enforces reversibility. Every stateful action in the session is traceable to a
single commit that can be reverted independently.

### 2.3 `config.js` is git-ignored and holds the real API key

**Decision:** the git-ignored `config.js` holds the real, deliberately unrestricted Google
Maps API key (local only). When temporarily edited for verification against a local backend,
it is backed up first, then restored **byte-identically** (verified with `diff`) afterwards.

**Why:** the key is local-only per user instruction; committing it would expose it. Every
verification round backed up + restored + verified `git status` was clean before proceeding.

**Location:** `.gitignore:2`; the file is never a staged path.

### 2.4 Measure before fixing

**Decision:** where a finding stated a *mechanism* rather than an observation, measure it
before writing code.

**Why:** the doc's mechanism was often wrong, and the truth was usually worse. This
discipline caught D1, D2, F3's mega-relation trap, F1's shared-track note, my own high-speed
claim, and the Berlin duplicate-vertex bug (see §11).

### 2.5 `PAYLOAD_VERSION` for shape-*and*-content changes

**Decision:** bump `PAYLOAD_VERSION` (v1 → v2 → v3) in `src/lines.js` whenever the
`/overpass/lines` payload changes in a way that breaks decoding by newer code — including
content changes (v3), not just shape changes.

**Why:** cache entries survive the deploy that filled them, so a shape or content change
silently keeps failing until the 30-day TTL. Same discipline as `CACHE_VERSION` in the
service worker. Adopted after the "hidden line kept appearing" incident during F1.

**Location:** `src/lines.js:PAYLOAD_VERSION`; caches key = `v{PAYLOAD_VERSION}:kind:level:bbox`.

### 2.6 Bump `CACHE_VERSION` on every asset content change

**Decision:** every commit that touches a shell asset's contents bumps
`service-worker.js:CACHE_VERSION` (v63 → v71 across this session).

**Why:** stale service-worker cache silently continues to serve the previous shell to
returning users; a version bump is what forces the update.

### 2.7 Reversibility over auto-fixing

**Decision (D1 and D2):** when hand-drawn geometry is malformed, *refuse* rather than
auto-fix. The points stay on screen so Undo works.

**Why:** a self-crossing bowtie is genuinely ambiguous (two triangles? a square with two
taps swapped?). "Fixing" it would guess, and a guess that silently changes which area gets
eliminated is exactly the failure the guard exists to prevent.

### 2.8 Delegate bulk mechanical work to Haiku 4.5

**Decision:** mechanical / high-volume subagent work runs on Haiku 4.5 to preserve limits.

**Why:** conservation of the shared plan. Reasoning-heavy investigation stays on the primary
model; searching, listing, sweeping does not.

---

## 3. §A — Silently wrong eliminations

The unifying theme: *every one of these fails quietly.* The error banner in `layers.js` only
fires on a *throw*, and none of these throw. A player with no devtools cannot tell a broken
question from a working one.

### A1. Fully-eliminated board rendered as fully-possible
- **Commit:** `481799b`
- **Mechanism:** `computeActiveArea` returned `safeDiff(gameArea, removed)`, and turf returns
  `null` once eliminations cover the whole area. `_render` then did
  `maskOutside(active || g.gameArea)`, falling back to the full game area — the state where
  the seeker most needs feedback rendered pixel-identical to a fresh game.
- **Decision:** distinguish "no game area" from "active area is empty" with an explicit
  `EMPTY_AREA` sentinel; render as a fully-masked board plus a banner saying every question
  combined ruled out the whole area.
- **Files:** `src/tools.js`, `src/layers.js`.

### A2. Thermometer eliminated a ±3° strip, not a half-plane
- **Commit:** `e6af0c6`
- **Mechanism:** hardcoded L = 3 (~330 km half-extent) claimed to cover any play area. Jet
  Lag S1 was played across whole countries, so on a Japan-sized board a Tokyo → Osaka
  "hotter" answer eliminated a band across the middle and left Sapporo alive.
- **Decision:** compute the bisector's extent from the board's actual bbox.
- **Files:** `src/tools.js` (`thermometer`).

### A3. `_inAreaFeatures` dropped out-of-area POIs, causing false eliminations
- **Commit:** `cbc38ba`
- **Mechanism:** the filter kept only features inside the play area, reasoning that outside
  places "could never be nearest". Wrong direction — a POI outside the board can be nearest
  to a hider near the boundary, and dropping it makes surviving seeds' cells larger than the
  true cells.
- **Decision:** keep out-of-area features with a generous bbox pad; the Voronoi clips cells
  to the game area, so outside seeds correctly shrink their neighbours without contributing
  a cell of their own.
- **Files:** `src/geo.js` (`featuresNearArea`).

### A4. Legacy tentacles steps eliminated the hider's own cell
- **Commit:** `2a3e29c`
- **Mechanism:** the tool routing for old (pre–seeker-radius) tentacles steps sent them
  through the Matching path (`voronoiTool`), which destructures `{ featureIndex, keep }`.
  `keep` came back undefined, `keep ? ... : selected` took the falsy branch and eliminated
  `selected` — shading exactly the cell the hider said they were closest to.
- **Decision:** route legacy steps through their own branch that treats the missing radius
  as "nearest-cell partition; keep the hider's cell, eliminate everything else."
- **Files:** `src/tools.js`.

### A5. Distance inputs ignored the imperial units setting
- **Commit:** `480a2cb`
- **Mechanism:** several inputs stored the entered number as metres regardless of the
  Settings unit toggle.
- **Decision:** funnel every distance input through `readDistanceMeters(s, id, units)` which
  converts based on the current setting.
- **Files:** `src/ui.js`, `src/layers.js`.

### A6. Voronoi degeneration silently dropped the question
- **Commit:** `d93196d`
- **Mechanism:** when `turf.voronoi` couldn't produce a cell for a candidate, `eliminated`
  came back `null`, the caller treated it as "answer eliminated nothing," and the question
  stayed enabled silently.
- **Decision:** *throw* on degeneration with a descriptive message; the outer catch marks
  the step failed and surfaces a banner, but the step is no longer silently pretending it
  ran.
- **Files:** `src/tools.js`, `src/layers.js`.

### A7. Failed union silently discarded an elimination
- **Commit:** `853def1`
- **Mechanism:** `removed = safeUnion(removed, elims[i]) || removed`, and `safeUnion`
  swallows its exception and returns `null`. One union failure dropped that step's entire
  eliminated region from the mask — the board showed area as still-possible that a question
  had ruled out, indistinguishable from a correct board.
- **Decision:** `computeActiveArea` now takes an `onFail(stepId, reason)` reporter and keeps
  going (dropping one step beats blanking the board), but the loss is visible. `_render`
  raises a distinct banner for a dropped elimination — worse than a failed guide, because
  the map looks healthy while missing a ruled-out region. "compute" and "union" failures are
  reported as separate reasons.
- **Files:** `src/tools.js`, `src/layers.js`.

### A8. Candidate filter left a hidden item checked
- **Commit:** `8ad7ffd`
- **Files:** the candidate chooser.

### A9. Zero / negative / non-numeric silently became 10
- **Commit:** `0fde90a`
- **Mechanism:** distance inputs clamped invalid values to a default 10, silently letting
  the question through with a fabricated distance.
- **Decision:** validate at input time; reject with a toast that names the problem. Zero is
  explicitly rejected (`turf.buffer(geom, 0)` returns `null` and semantically cannot divide
  a map).
- **Files:** `src/ui.js`.

---

## 4. §B — Data completeness

The exhaustive station list.

### B1. Places pagination fired 400 ms too early → exactly 20 results
- **Commit:** `ff5eca2`
- **Files:** `src/places.js`.

### B2. `THIN = 2` made the exhaustive Overpass source unreachable
- **Commit:** `d66dd4f`
- **Decision:** raise the threshold and invert priority so Overpass is the primary path for
  dense categories. **Ships alongside D3**, because inverting priority moved a
  ~64%-flaky dependency onto the critical path of the app's most common action.

### B3. Station's Name Length was silently wrong in any dense metro
- **Commit:** `8782066`
- **Mechanism:** an arbitrary cap of 60 stations partitioned the wrong subset.

### B4. `searchText` never paginated
- **Commit:** `b454689`
- **Files:** `src/places.js`.

### B5. Auto-find silently covered only a 50 km disc
- **Commit:** `49a0b0f`
- **Decision:** warn when Google's 50 km search radius can't span the board, rather than
  silently missing far edges.

### B6. Overpass fallback ignored the caller's centre and radius
- **Commit:** `4547f10`
- **Files:** `server.js`, `src/places.js`.

### B7. Type-a-station-name resolution
- **Commit:** `c8c5d6e`
- **Decision:** resolve typed names against the local list first (fast, accurate for the
  common case), fall back to Places / Overpass search only when unresolved.

---

## 5. §C — State and persistence

### C1. `importGame` overwrote the game it shared an id with
- **Commit:** `63e698e`
- **Decision:** if an imported game's id already exists, save it as a new id and record
  `importedFrom` for provenance.

### C2. Redo died on reload
- **Commit:** `3784246`
- **Decision:** persist `redoStack` alongside `history`; both survive a reload.

### C3. Removing every zone orphaned the guides
- **Commit:** `52e237e`
- **Files:** `src/zones.js`, `src/layers.js`.

### C4. Transit desynced from its toolbar button on game switch
- **Commit:** `7318b76`
- **Files:** `src/app.js`.

---

## 6. §D — Robustness

### D1. Hand-drawn polygons were never validated → silent misuse
- **Commit:** `4b037d2`
- **Doc mechanism:** self-crossing "Body of Water" → `turf.buffer` throws → `null` → zero
  elimination.
- **Measured mechanism (overturned):** `turf.buffer` **does not throw** on a bowtie. It
  returns a Polygon; the step eliminates **409 km²** where the intended square eliminates
  **304 km²**. A confident, plausible, *wrong* elimination.
- **Also worse than documented:** the *zone* path (`zones.js._finishDraw`) was not in scope
  of the finding. A self-crossing zone makes `unionRings` return a **valid Polygon of area
  0** (lobes wind opposite ways and cancel), so the board silently has no area at all, and
  `computeActiveArea` returns the degenerate polygon rather than A1's `EMPTY_AREA` — even the
  empty-board banner does not fire.
- **Decision:** refuse rather than auto-fix. Guarded at all three entry points
  (`_drawShape({ ring: true })` for the two polygon call sites; `zones.js._finishDraw`;
  `importText`). The two *line* draw sites are exempt on purpose: a line has no closing edge
  and a self-crossing trace still buffers correctly. Pasted GeoJSON skips bad rings
  individually so one bad polygon does not throw away the good ones.
- **Files:** `src/geo.js` (`ringSelfIntersections`), `src/layers.js`, `src/zones.js`.
- **Tests:** `test/ring-validation.test.mjs`, including a **spiral that is clean as an open
  path and self-crossing only once closed** — the crossing lives on the implicit last→first
  edge, which is invisible while tapping.

### D2. No antimeridian handling in the coordinate pipeline
- **Commit:** `c5f14ad`
- **Doc mechanism:** `unionRings` → `null` → "Add a zone first" after adding one; the
  minimum fix was to distinguish "union failed" from "no zones".
- **Measured mechanism (overturned):** `unionRings` **succeeds**. A ~470 km² Taveuni (Fiji)
  board that straddles the line unions to a **valid Polygon of 851,313 km²** — ~1800× too
  big, spanning the Pacific. The prescribed fix would have been a **no-op**.
- **Decision:** refuse rather than silently wrap. Marked as a **judgment call and reversible**
  — a proper unwrap is possible but a *half fix*: unwrapping the ring alone gets the area
  right (473 km², correct) but a POI at `-179.95` as Places returns it then reads as
  *outside* the unwrapped board and is silently missed. A real fix has to unwrap every point
  entering the geometry layer (Places, Overpass, seeker positions, radar centres,
  thermometer endpoints, line geometry) into the board's frame — a large change to the
  99.99% case for the handful of boards affected (Fiji, the Chathams, Chukotka, Tuvalu). A
  wrong board is worse than no board.
- **Files:** `src/geo.js` (`ringCrossesAntimeridian`), `src/layers.js`, `src/zones.js`.
- **Non-regression tested:** a **London** board straddling the **prime** meridian is
  correctly unaffected — crossing 0° is what every London board does, and confusing the two
  would break the ordinary case.

### D3. Overpass proxy mis-detected a busy endpoint as a parse error
- **Commit:** `01ba92b`
- **Mechanism:** public Overpass fails ~half the time; some failures return HTTP 200 with an
  HTML body, which `runOverpass` mis-reported as a parse error.
- **Decision:** distinguish HTML-bodied 200s from JSON, and treat as busy (retry via
  fallback endpoint) rather than fatal (400). Ships before B2, because B2 moves this flaky
  dependency onto the critical path of the most common action.
- **Files:** `server.js`, `overpass.js`.

---

## 7. §E — Dead code and rendering

### E1. `data/linear.js` was documented but never wired
- **Commit:** `b69b7f8` (deletion). Followed by `12f6b85` (worldwide auto-sourcing).
- **Decision (initial):** delete rather than wire. Rationale: **the user's brief:** *"the
  exact lines used automatically, without my input. Mumbai should not have an advantage in
  any stage."* Wiring the module would hand Mumbai two accurate reference lines and every
  other board nothing.
- **Decision (later, `12f6b85`):** source Coastline / International Border / 1st Admin
  Division Border / High Speed Rail from OSM via the proxy. Every board gets the same
  accuracy. 2nd Admin Division stays hand-drawn because the second division has **no fixed
  `admin_level` worldwide** (5 / 6 / 8 by country) and guessing would be silently wrong
  wherever the guess didn't match — the §A failure mode, exported worldwide.
- **Doc coupling:** README (`README.md:34-35`), GUIDE.md §Phase 4, `service-worker.js`
  `SHELL_ASSETS`, and `CACHE_VERSION` were all updated. `test/shell-assets.test.mjs` was
  written so that the SW-precache / file-deletion coupling can't bite silently again (it had
  bitten twice: E2, then E1).
- **Files:** `src/data/questions.js`, `src/lines.js` (`lineGeometry`), `src/layers.js`
  (`_measureLine`, `_autoLine`), `src/tools.js` (guide branch for `MultiLineString`),
  `overpass-lines.js`.
- **Tests:** `test/measure-line.test.mjs`, `test/shell-assets.test.mjs`.

### E2. `i18n.js` and `langs/en.js` were dead but precached
- **Commit:** `f7ee567`
- **Decision:** delete, remove from SHELL_ASSETS, bump `CACHE_VERSION`. `cache.addAll` is
  atomic and one dead entry fails the whole SW install silently.

### E3. `Focus.point()` was dead
- **Commit:** `d3ce1b8`

### E4. Socket.IO relay outlived its client — *parked, recorded only*
- **Not committed.** Multiplayer is deliberately out of scope. The dead surface is
  recorded so it isn't forgotten but is *not* work-to-do.

### E5. Every renderer double-rendered at boot
- **Commit:** `e49c4f3`
- **Mechanism:** `store.subscribe()` renders synchronously when a current game exists (and
  `app.js` awaits `store.init()` first), so an explicit `render()` in each init doubled
  every overlay at boot.

### E6. `GUIDE.md` §5.5 documented the superseded Tentacles model
- **Commit:** `504c8e2`

### E7. `_chooseTentacle` had no add-candidate escape hatch
- **Commit:** `842a271`

---

## 8. §F — Transit line data

### F0. Why we were currently immune
- **No code.** Explanatory: the shipped card was station-based, and its silent trap couldn't
  bite until we tried to answer by *line*.

### F1. "Metro Lines" answered a different question than the card asks
- **Commits:** `4bcdee0` (warning), `eefbbef` (source metro lines), `39b7e0c` (partition by
  line), `9b9cb7f` (mode + line filter).
- **Mechanism:** the card asked "which metro *line* are you nearest?" but the code
  partitioned by nearest **station** — wherever station spacing exceeds line spacing, the
  nearest station can sit on a line the hider is not beside, and a truthful "nearest line A"
  gets recorded as B and eliminates the hider's real position.
- **Decision (staged):**
  1. `4bcdee0` — warn at the card, without changing behaviour.
  2. `eefbbef` / `39b7e0c` — once §G1 landed the geometry, wire `candidateLines(kind, area,
     center, radius)` → group route relations into real lines by `ref` (with `name` as
     fallback), and use `lineCells` inside `tentacles` to partition by line.
  3. `9b9cb7f` — every rail *mode* (metro / light rail / train / tram / monorail) and every
     individual *line* is switchable per board, persisted as **hidden** so anything new
     (a mode this board didn't have, a line that opens later) is visible by default. Ruled
     by the user's brief: *"tram is a valid method of rail, but every method should be able
     to be turned on/off by the user."*
- **Rejected: name-only grouping.** DC has 6/145 relations with no `ref`, so name is the
  fallback, not the primary. Rejected: merging heavily-overlapping *lines* into one (see
  shared-track discussion at §10.5 below).
- **Files:** `overpass-lines.js`, `src/lines.js`, `src/tools.js`, `src/data/questions.js`,
  `src/layers.js`, `styles/main.css`, `index.html`.

### F2. Hand-drawn lines were sampled at 400 m
- **Commit:** `acc2ef6`
- **Mechanism:** `matchingNearestLine` densified each drawn line to points every 400 m —
  right for country boards, absurdly coarse for a city block.
- **Decision:** scale the step with the board (1 % of the diagonal, clamped 25 m–400 m).
- **Files:** `src/tools.js` (`lineStepMeters`, `LINE_STEP_FRACTION`, `LINE_STEP_MIN_M`,
  `LINE_STEP_MAX_M`).

### F3. OSM trap — *deferred, but the fix is written down*
- **Not committed (by decision).** Documented in `REVIEW_FINDINGS.md`.
- **Doc mechanism:** stop-node IDs on a mega-relation.
- **Measured mechanism (overturned):** F3's stop-node-ID trap does not reproduce in 8/8
  cities, including DC. There's no station↔line ID test in the geometry partition. The real
  §F3-class risk is different: on `route=train`, `ref` is sometimes the OPERATOR (Tokyo `KS`
  merges Keisei Main + Oshiage; Paris `H` merges 32 Transilien services) — which is *why*
  the Metro Lines card excludes `train`.
- **Decision:** the trap does not bite the current card, so nothing to fix — but the
  warning stays in the code (`src/lines.js:groupIntoLines` comment), so this function is
  never pointed at mainline rail as-is.

### F4. Google-native line-geometry option — **superseded by G1**
- **Not committed.** G1 covers everything F4 would have and does not depend on the raster
  transit layer.

---

## 9. §G — Showing rail lines on the map

### G0. Why the transit layer can't be fixed from Google's side
- **Not code.** Recorded because it justifies §G1: `google.maps.TransitLayer` is raster
  tiles from Google's own feed inventory, takes no options, no agency knob, no restyle.

### G1. Rail geometry from Overpass via the proxy — *the whole track from spike to shipped*

Landed as multiple commits, in this order:

1. **`7d389f2` — G1 spike: the doc's Overpass clip query silently returns zero ways.**
   - **Silent bug found by measuring the doc.** `relation[…](BBOX)->.r; way(r)(BBOX);`
     returned **0 ways** in Mumbai *and* Berlin. `->.r` names the set; `way(r)` recurses
     from the default set `_`, which is then empty. HTTP 200 + valid JSON + empty
     `elements` = nothing raises. Would have shipped an empty rail layer forever.
   - **Fix:** `way(r.r)`. Guarded by a **string-assertion test** on the built query, because
     a plausible-looking edit would silently reintroduce the bug.

2. **`a134b71` — G1: teach the proxy `out geom` — `GET /overpass/lines`.**
   - New endpoint on the proxy. Route decisions (measured, not reasoned):
     - **Server clip mandatory, lossless.** Unclipped Berlin is 34 MB / 33.9 s against a
       45 s fetch timeout. `way(r.r)(BBOX)` is 8.5 MB and does not truncate lines at the
       edge.
     - **Names via `.r out body;`, not `out geom(BBOX)`.** The latter puts names and clipped
       geometry in one pass but duplicates shared way geometry once per relation (Berlin:
       19,720 member-geoms for 5,605 unique ways). `out body;` + `way(r.r); out geom;` is
       smaller *and* the de-duplication is what the render depends on.
     - **Payload shape `{ lines:[{name,ref,route,wayIds}], ways:{id:coords}, counts }`.**
       Rejected `[{name,ref,coords}]` because two consumers want different things and that
       shape only serves one: the render needs each physical track drawn once (inlining
       repeats shared rails 3× on Berlin), and F1/F4 want per-line grouping (which
       `wayIds` gives losslessly).
   - **Doc deviations, all flagged:** names are **not** "free to carry" (costs a query
     step); `out geom` rejected as above; §G1's "one bold uniform stroke" deviated to
     coloured-by-mode (still one stroke per way).

3. **`b1989b1` — G1: draw the rail lines — client fetch, cache and 🚄 toggle.**
   - Cache-first, then network, then STALE cache. **The stale step is load-bearing:** a
     board is played outdoors, and a month-old rail line is worth far more than an empty
     map when Overpass is busy or there's no signal.
   - `boardBbox` pads the board 10 % and snaps to 3dp, so a byte-identical bbox comes out
     of a jittered polygon — the cache depends on it. A degenerate area returns `null`
     rather than fetching the planet.
   - **Errors are spoken.** A 400 keeps its detail; a 502 (endpoints busy) says so
     differently. No proxy configured is a clear message, not a silent blank.
   - **`PAYLOAD_VERSION = 2`.** Added later as v1 → v2 when `route` was added per line.
     Bumped to v3 later still (see §10.6).

4. **`9b9cb7f` — Rail: every mode and every line is switchable, per board.**
   - See F1 above; this is where the toolbar `🚄 Rail` panel came in.

**Live verification during G1:** a Mumbai board was driven end to end. `hiddenRoutes:
["train"]` → drew 48 ways (the 7 metros) instead of 271; also hiding metro Line 1 → 42 ways;
the Metro Lines card then offered 6 lines (not 7) with `hidden: 1`. Persisted correctly.
`config.js` restored byte-identically after every check.

### G2. OpenRailwayMap tile overlay — *rejected on licensing*
- **Not committed.** The tiles' license would require attribution the app can't reliably
  guarantee across all game-flow states.

### G3. Why G1 is worth the extra work — it collapses §F
- **Not code.** Recorded because G1's landing means F1's fix is a *small increment* rather
  than a station-Voronoi hack — and F4 is retired rather than piled on.

---

## 10. Silent bugs found *during* the fixes

The category the changelist added itself, and the most important part of this session. Every
one of these is a §A-class silent bug that shipped with the fix that was supposed to *remove*
silent bugs.

### 10.1 The doc's Overpass clip query returned zero ways
Covered above at §9.G1.7d389f2. **The first measurement of the session and the reason
"measure before fixing" became a cross-cutting decision.**

### 10.2 D1 truth was worse than documented
Covered at §6.D1. Predicted "zero elimination" (which a seeker might notice); measured a
**409 km² wrong elimination** (which looks correct); worse still, a bowtie *zone* produces
a **0-area board** and even A1's empty-board banner doesn't fire because
`computeActiveArea` returns the degenerate polygon rather than `EMPTY_AREA`.

### 10.3 D2 truth was worse than documented
Covered at §6.D2. Predicted `unionRings → null` (which the prescribed fix would have
addressed); measured `unionRings → valid Polygon of 851,313 km²` (~1800× too big) with
nothing failing. The prescribed fix would have been a **no-op**.

### 10.4 F3's mega-relation trap does not reproduce; the real trap is `train.ref = operator`
Covered at §8.F3. Predicted stop-node-ID trap on mega-relations; measured across 8 cities
including DC and the trap doesn't reproduce. The real §F3-class risk on `route=train` is
that `ref` is sometimes the OPERATOR (Tokyo `KS`, Paris `H`), which would over-group — and
that's *why* the Metro Lines card excludes `train`.

### 10.5 F1's shared-track note was wrong twice
- **Commits:** `9c4f119` (fix), `630e45b` (18× speedup + second silent bug).
- **The note said:** *"two lines on identical track (Berlin's S41/S42 Ring, which carry
  different refs but share rails) still partition arbitrarily... It is narrow... The seeker
  can untick one of them."*
- **Measured on a real Berlin board:**
  - **S41/S42 share zero ways.** OSM maps each direction of the Ring on its own parallel
    way ~10 m apart. They were never the case in question.
  - **The real case is not narrow.** Berlin's Stadtbahn trunk is shared by four lines at
    ~95 %:

    | pair | shared ways | Jaccard |
    |---|---|---|
    | S5 vs S7 | 267 / 282 | 0.95 |
    | S8 vs S85 | 150 / 180 | 0.83 |
    | S3 vs S5 | 261 / 318 | 0.82 |
    | S3 vs S7 | 262 / 324 | 0.81 |

- **Failure mode:** a hider beside the trunk is *exactly* equidistant from all four lines
  (measured 23 m each at Friedrichstraße). They cannot answer the card. The old code
  eliminated the other cells regardless — those cells were divided by `dejitter` nudging
  co-located seeds ~0.6 m apart, so the boundary through the trunk was decided by **the
  nudge direction and nothing else.**
- **Fix:** one seed per coordinate, owned by every line that reaches it. Cells overlap
  exactly on shared rails — the truth being modelled. `tentacles` computes
  `eliminated = gameArea − (cell ∩ seeker)`, so a larger cell eliminates strictly *less* —
  the overlap can only ever be conservative, never wrong.
- **Rejected: merging heavily-overlapping lines into one choice.** Throws away the
  divergent ends (the 5 % of S5/S7 that *is* answerable), and there is no defensible
  threshold — Berlin's pairs run 0.95 / 0.83 / 0.82 / 0.47 with no gap, and transitive
  merging would cascade S5~S7~S9~S3 into one blob. Ambiguity is a property of *where the
  hider stands*, not of a pair of lines, so it belongs in the geometry, not in a cutoff.
- **Still out of scope (now stated accurately):** near-parallel *distinct* tracks (the
  actual S41/S42, ~10 m apart) still partition down the middle of their corridor.
  Geometrically well-defined and humanly meaningless, but unlike shared track it is not
  silently wrong: a point really is nearer one of them. `test/shared-track.test.mjs` pins
  that limit rather than implying the fix covers it.

- **Second silent bug found while profiling the fix (`630e45b`):**
  - The old fold was `cells[idx] = cells[idx] ? safeUnion(cells[idx], clip) : clip`.
    `safeUnion` swallows its exception and returns `null`, so one failure mid-fold left
    `cells[idx]` null — and the *next* iteration took the falsy branch and **restarted
    from that single cell**. Everything gathered so far vanished, the line's region came
    out a fragment, and since a smaller cell eliminates *more*, the result was a false
    elimination. Nothing threw. An A7-shaped bug hiding one level down in `lineCells`'
    own internals.
  - **Fix:** merge each line's cells once, and *throw* on failure like the voronoi call
    beside it.
- **18× speedup, free.** Merging each line's cells once instead of folding pairwise on a
  growing polygon: **3534 ms → 191 ms** on real Berlin S5+S7 (1744 seeds), identical
  output. My first guess was that the *union count* was the problem; batching a synthetic
  400-cell union was only 1.9×. The real structure (folding on an ever-growing polygon)
  is what actually bit, and only profiling the real board showed it.

### 10.6 Metro Lines was **DEAD** on 5 of the 8 largest metro networks
- **Commits:** `1b2e433` (fix), `cdd6480` (docs — sweep across 8 cities).
- **Cause:** mine, from G1. `r5` rounds to 5dp (~1.1 m), which collapses vertices mapped
  closer than that into **exact duplicates**. `turf.pointToLineDistance` throws
  `coordinates must contain numbers` on the resulting zero-length segment.
- **Scale:** only **4 of 282** ways on the S5/S7 capture carry one (~1 %). But
  `candidateLines` measures *every* line, so one throw escaped the whole set:
  **1 % of the data took down 100 % of the card.** `layers.js` then caught it and reported
  *"Couldn't load metro lines — falling back to stations"* — a code bug of mine wearing an
  outage's clothes, silently reverting Berlin to the station Voronoi §F1 exists to remove.
  **Exactly the confusion D3 was filed for, one layer up.**
- **Sweep across the 8 cities `groupIntoLines` was measured on:**

  | city | duplicates `r5` would create | Metro Lines card, before |
  |---|---|---|
  | London | 87 | dead |
  | Berlin | 53 | dead |
  | NYC | 22 | dead |
  | Paris | 16 | dead |
  | Tokyo | 3 | dead |
  | Mumbai | 0 | worked |
  | Singapore | 0 | worked |
  | Washington | 0 | worked |

- **Fix at source:** `normalizeLines` drops repeated consecutive vertices; the existing
  `minCoords` check then drops any way that collapses below 2 points (correct — it was
  under ~1 m long).
- **`PAYLOAD_VERSION` → v3.** The shape was unchanged, but the *content* was broken, and a
  v2 entry cached before this fix would keep failing Berlin's card from the 30-day cache
  and keep blaming the network.
- **Verified live in the browser:** 25 lines offered on Berlin, nearest to Alexanderplatz
  = S3 at 157 m.

### 10.7 Coastline was **DEAD** on any fjord or archipelago
- **Commit:** `b0a2670`.
- **Cause:** `turf.buffer` on a moderately dense MultiLineString scales explosively.
  Bergen fjords in a 0.15° × 0.25° box return 457 pieces / 13,405 vertices, and:

  | buffer distance | time | heap |
  |---|---|---|
  | 100 m | 109 s | 1.9 GB |
  | 500 m | 279 s | 3.6 GB |
  | 1000 m | | **OOMs at 4 GB** |

- **Nothing throws until the OOM.** On any fjord / archipelago board (Norway, Sweden,
  Greek islands, Philippines, …) the Coastline card just froze mid-question.
- **Fix:** Douglas–Peucker simplify (`turf.simplify`, tolerance 5e-4° ≈ 55 m) before
  buffering, gated on vertex count > 500. Bergen 13,405 → 1,354 verts, 1 km buffer runs
  in 16 s / 500 MB, area 121 km². The ~55 m tolerance is a 5 % edge shift at 1 km, and the
  fingertip errors it replaces are 100–500 m — strictly better than the hand-drawn card
  it supersedes.
- **Verified live:** Bergen → 24,384 verts (denser than the fixture), buffer 17.9 s;
  Mumbai → 3,039 verts, buffer 574 ms; Mumbai raw vs simplified error 0.8 %.

### 10.8 My own "OSM tags high-speed inconsistently" claim was wrong
- **Commit:** `982b6df`.
- **What happened:** I shipped `hs_train` hand-drawn in `12f6b85`, justifying it in the
  commit and the README with *"OSM tags high-speed service inconsistently across networks;
  no single query returns 'the high-speed lines' everywhere."* Asserted from general
  knowledge, not measured — in a commit *inside the catalogue of exactly that mistake*.
- **Measured (2026-07-17):**

  |  | `railway=rail` | `highspeed=yes` | rel-level `highspeed` |
  |---|---|---|---|
  | France LGV | 554 | **100** | 62 |
  | Spain AVE | 47 | **20** | 0 |
  | Japan Shinkansen | 2027 | **291** | 0 |
  | Germany ICE | 230 | **54** | 17 |
  | London HS1 | — | **80** | — |
  | Mumbai (no HSR) | 871 | **4** ← all `railway=construction` | 0 |

  Way-level `highspeed=yes` is consistent **9/9** (LGV, AVE, Shinkansen, ICE, China,
  Italy, KTX, THSR, HS1). Only *relation*-level tagging is inconsistent (2/4), and this
  card never needed relations. My claim was true of the thing I didn't need and false of
  the thing I did.
- **Two details only measurement gave:**
  - **`railway=rail` is load-bearing**, not tidiness. Mumbai has four ways tagged
    `highspeed=yes` — the Mumbai–Ahmedabad line, still under construction. A line nobody
    can ride must not answer this card. ("Mumbai should not have an advantage" cuts both
    ways: nor a handicap.)
  - **A `maxspeed` threshold is the trap.** HS1's approach into St Pancras is tagged
    `maxspeed=40`, so `maxspeed>=250` silently drops the terminus end of a real
    high-speed line. §A again.
- **How I nearly confirmed the wrong claim:** my *first* probe returned 0 for France and
  Spain, which would have "confirmed" the claim — but the bounding boxes were simply
  wrong. **A control count of `railway=rail` in the same box is what caught it: 0 / 554
  is a finding, 0 / 0 is an empty box.** A measurement without a control is just a slower
  assertion.

---

## 11. Method notes — what worked and what didn't

### 11.1 What worked

- **Measurement of the doc's mechanism.** Overturned four findings (G1's clip query, D1,
  D2, F3) and two of my own claims (F1's S41/S42 example, HSR tagging). Every measurement
  found the reality was worse than described.
- **Real data through real code.** Fixtures captured from Overpass, not hand-written
  objects — they carry structure invented fixtures don't (member nodes with `role: "stop"`
  mixed into ways, member lists with most refs pointing outside the bbox, direction
  suffixes with no single convention).
- **String-assertion tests on load-bearing queries.** The `way(r.r)` guard, the `highspeed`
  query clauses, and the `LINE_KINDS` list are all pinned so a plausible-looking edit is a
  test failure.
- **Reverting the fix to verify tests catch the bug.** Every silent-bug test in this
  session was confirmed to fail on the pre-fix code before shipping. Otherwise a passing
  test is just documentation.
- **Browser verification against the deployed app.** Caught the two shipped-with-the-fix
  bugs (Berlin Metro Lines, Norway Coastline). The unit tests couldn't see them because the
  fixtures were the cases where the bugs cannot occur.

### 11.2 What did not

- **Trusting a *fixture-based* passing test as a definition of "works."** Berlin, London,
  NYC, Paris, Tokyo — 5 of the 8 largest metro networks — had a dead Metro Lines card while
  238 tests passed, because the fixtures were Mumbai, Singapore and DC. Real data is not
  representative data when the fixtures were picked early for convenience.
- **Predicting a mechanism instead of measuring it.** Four doc findings were overturned by
  measurement, and I did it to myself twice more (S41/S42, HSR). A stated mechanism in a
  review is a *hypothesis*; only the symptom is evidence.
- **Assuming the union count was the bottleneck.** I profiled a synthetic 400-cell batched
  union and saw a 1.9× speedup — nearly ended the investigation. The actual bottleneck
  was pairwise folding on a growing polygon, only visible on the real Berlin board.
  **Synthetic benchmarks of what you assume is slow can exonerate the code that is
  actually slow.**
- **My first HSR probe on France and Spain returned 0 — which would have "confirmed" the
  wrong claim.** The bboxes were wrong. A control count in the same box caught it. A
  measurement without a control is a slower assertion.

---

## 12. Known limitations still open

- **Near-parallel distinct tracks** (the real S41/S42, ~10 m apart) still partition down
  the middle of the corridor. This is geometrically well-defined and humanly meaningless,
  but *unlike* shared track it is not silently wrong: a point really is nearer one of
  them. Pinned as an explicit limit in `test/shared-track.test.mjs`.
- **Antimeridian-straddling boards refused, not supported.** Reversible; the doc records
  the "unwrap the whole geometry pipeline" plan.
- **2nd Admin. Division Border stays hand-drawn.** The 2nd division has no fixed
  `admin_level` worldwide.
- **F3 is a standing note.** The doc keeps the warning so `groupIntoLines` is never
  pointed at `route=train` as-is.
- **E4 multiplayer is parked**, by decision.
- **Cache-stale coastline / rail data can be up to 30 days old.** Deliberate — a
  month-old rail line beats a blank map on a board with no signal — and the card says
  "Showing an offline copy" when it happens.

---

## 13. Summary table — commits this changelist landed

| # | commit | subject |
|---|---|---|
| 1 | `481799b` | A1: fully-eliminated board no longer renders as fully-possible |
| 2 | `e6af0c6` | A2: Thermometer eliminates a half-plane, not a fixed ±3° strip |
| 3 | `cbc38ba` | A3: stop dropping out-of-area POIs |
| 4 | `2a3e29c` | A4: legacy tentacles no longer eliminate the hider's own cell |
| 5 | `480a2cb` | A5: distance inputs honour imperial units |
| 6 | `d93196d` | A6: Voronoi degeneration surfaces as a failure |
| 7 | `853def1` | A7: failed union no longer silently discards an elimination |
| 8 | `8ad7ffd` | A8: candidate filter no longer leaves a hidden item checked |
| 9 | `0fde90a` | A9: validate distance input instead of clamping to 10 |
| 10 | `ff5eca2` | B1: Places pagination cap fix |
| 11 | `01ba92b` | D3: Overpass proxy no longer mis-detects busy as parse error |
| 12 | `d66dd4f` | B2: Overpass reachable for completeness |
| 13 | `8782066` | B3: Station's Name Length no longer partitions arbitrarily |
| 14 | `c8c5d6e` | B7: resolve typed station name against local list first |
| 15 | `b454689` | B4: paginate searchText |
| 16 | `49a0b0f` | B5: warn when Google search radius can't span the board |
| 17 | `4547f10` | B6: Overpass query respects caller's centre and radius |
| 18 | `63e698e` | C1: importing no longer overwrites a same-id game |
| 19 | `3784246` | C2: redo stack survives a reload |
| 20 | `52e237e` | C3: removing every zone no longer orphans guides |
| 21 | `7318b76` | C4: transit no longer desyncs on game switch |
| 22 | `e49c4f3` | E5: stop double-rendering at boot |
| 23 | `f7ee567` | E2: delete dead i18n |
| 24 | `d3ce1b8` | E3: delete dead Focus.point() |
| 25 | `504c8e2` | E6: update GUIDE §5.5 |
| 26 | `842a271` | E7: give _chooseTentacle an add-candidate escape hatch |
| 27 | `4bcdee0` | F1: warn that Metro Lines partitions by station |
| 28 | `7d389f2` | G1 spike: clip query silently returned zero ways |
| 29 | `acc2ef6` | F2: scale the nearest-line sampling step with the board |
| 30 | `b69b7f8` | E1: delete never-wired Mumbai linear data |
| 31 | `a134b71` | G1: teach the proxy `out geom` |
| 32 | `b1989b1` | G1: draw rail lines |
| 33 | `eefbbef` | F1 (1/2): source metro lines |
| 34 | `39b7e0c` | F1 (2/2): partition by line, not by station |
| 35 | `9b9cb7f` | Rail: every mode and line is switchable, per board |
| 36 | `12f6b85` | Measuring: source coastline and borders |
| 37 | `4b037d2` | D1: refuse self-crossing outline |
| 38 | `c5f14ad` | D2: refuse board across the date line |
| 39 | `bf5f09e` | docs: changelist is complete |
| 40 | `e44ced6` | docs: README — Measuring references are sourced |
| 41 | `982b6df` | Measuring: source the high-speed line too — my own claim was wrong |
| 42 | `9c4f119` | Nearest-line: shared track belongs to every line on it |
| 43 | `630e45b` | Nearest-line: merge each line's cells once — 18× faster |
| 44 | `1b2e433` | Metro Lines was DEAD on Berlin |
| 45 | `cdd6480` | docs: the Berlin bug was 5 of 8 largest metros |
| 46 | `b0a2670` | Measuring Coastline: simplify before buffering, or Norway OOMs |
