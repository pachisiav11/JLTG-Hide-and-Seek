# Review findings — actionable changelist

Full-project review at xhigh effort (2026-07-15), plus two code-level playthrough
workflows and one competitive-research workflow. **37 items, none applied yet.**

Scope note: **multiplayer is deliberately out of scope** — §E4 is recorded only so the
dead surface isn't forgotten, not as work to do now.

Update 2026-07-15: **the §G1 Overpass spike has been run** against live endpoints. The
premise held, but the measured results corrected three things I'd written from reasoning
alone — see the CORRECTION blocks in §G1. Still no code changes applied anywhere.

Knock-on effects of that spike, applied across this doc on re-read:
- **D3 is new** (item 37) — public Overpass fails ~half the time and the proxy mis-reports
  it as a parse error. Found while spiking §G, but it lands on **§B2's** critical path.
- **B2 now carries a warning** — it inverts Google/Overpass priority, which moves that
  flaky dependency onto the app's most common action. B2 ships *with* D3, not before it.
- **F4 is superseded** by G1 and should not be spiked first.
- **F1's fix is now scheduled, not hypothetical** — G1 returns the geometry it needs.
- **F3 is no longer deferred-by-default** — G1 puts OSM line data in the app for real.

Verification legend:
- **[V]** — verified by running the geometry, or by direct read of the exact lines.
- **[R]** — reported by a playthrough workflow, confirmed by read, not executed.

The unifying theme of §A: **every one of these fails quietly.** The error banner in
`layers.js` only fires on a *throw*, and none of these throw. A player with no devtools
cannot tell a broken question from a working one.

---

## A. Silently wrong eliminations (fix first — these corrupt live games)

### A1. A fully-eliminated board renders as fully-possible **[V]**
`src/layers.js:139`

`computeActiveArea` returns `safeDiff(gameArea, removed)`, and turf returns `null` once
the eliminations cover the whole area (verified: `turf.difference` of a fully-covered
polygon → `null`). `_render` then does `maskOutside(active || g.gameArea)`, falling back
to the **full game area**, and `if (active)` skips the outline. The one state where the
seeker most needs feedback — a mis-entered answer, an inconsistent hider — renders
pixel-identical to a fresh game.

**Change:** distinguish "no game area" from "active area is empty". Have
`computeActiveArea` return an explicit empty sentinel, and render the empty state as a
fully-masked board plus a banner ("every question combined rules out the whole area —
check the most recent answer").

### A2. Thermometer eliminates a ±3° strip, not a half-plane **[V]**
`src/tools.js:68`

`const L = 3;` (~330 km half-extent), with a comment claiming it "covers any play area".
Verified on a Japan-sized area (2.39M km²) with a Tokyo→Osaka "hotter" answer: eliminates
440k km² against an expected ~1.19M km², and Sapporo — unambiguously colder — survives.
Jet Lag S1 was played across whole countries, so this is the normal case.

**Change:** derive the extent from the game-area bbox instead of hardcoding it — compute
the projected bbox diagonal and use a multiple of it, so the strip always overshoots the
board. Note `bisG` (`tools.js:90`) already mixes an unprojected bbox into projected
space; fix both together.

### A3. `_inAreaFeatures` drops out-of-area POIs, causing false eliminations **[V]**
`src/layers.js:374` — call sites `layers.js:807` (Matching-nearest), `layers.js:1236` (Measuring-points)

A POI outside the play area can genuinely be the nearest to a hider near the boundary.
Play area = a city; nearest Commercial Airport is 30 km outside and gets dropped. The
Voronoi cell computed over only-inside POIs is **larger** than the true cell, so a
"No — different" answer eliminates that oversized cell — removing the area where the
hider actually is. For Measuring the reference set can be emptied entirely. The comment
("places they could never be nearest to") has the logic backwards.

**Change:** stop filtering candidates by area membership. Points outside the board are
legitimate partition seeds; only the *resulting cells* should be clipped to the game area
(`voronoiCells` already does this). If a bound is wanted, use a padded bbox, not
containment.

### A4. Legacy tentacles steps eliminate the hider's own cell **[V]**
`src/tools.js:314`

`radius == null` falls back to `voronoiTool`, which destructures `{ featureIndex, keep }`
— but tentacles answers only ever carry `{ featureIndex }` or `{ none: true }`. `keep` is
`undefined` → `keep ? safeDiff(gameArea, selected) : selected` takes the falsy branch →
`eliminated = selected`. It shades exactly the cell the hider said they were closest to.
An `{ none: true }` legacy answer is ignored entirely.

**Change:** give the legacy path its own branch that maps `featureIndex` → keep-the-cell
and `none` → eliminate-the-union-of-circles, rather than reusing `voronoiTool`'s
Matching-shaped answer contract. (One playthrough reported "no inversions found" — it did
not trace this fallback path.)

### A5. Distance inputs ignore the imperial units setting **[V]**
`src/layers.js:690` (Radar) · `src/layers.js:1195` (Measuring) · `src/focus.js:118` (Hider zone)

All three are hard-coded to "metres" while the rest of the app honours
`settings.units` — the Measure readout (`features.js:142`) and area summary
(`zones.js:119`) both convert. An imperial player sees ft/mi everywhere else, types the
mile value the hider gave them into a field labelled "metres", and the buffer is off by
~1609×.

**Change:** label and convert these three fields from `settings.units`, reusing the
existing `formatDistance` conventions; store metres internally as now.

### A6. Voronoi degeneration silently drops the question **[R]**
`src/tools.js:151`

The `catch` returns `{ cells: features.map(() => null) }` **without rethrowing**, so
`_render`'s per-step try/catch (`layers.js:163`) never increments `failed`, the "N
questions failed" banner never appears, and `computeActiveArea`'s own catch
(`tools.js:462`) sees no exception. The question stays checked and enabled, contributing
zero shading, traced only by a `console.warn`. Trigger is realistic: near-collinear points
— stations along one straight rail line, i.e. the Metro Lines and Station's Name Length
candidate sets.

**Change:** propagate degeneration as a real failure so the existing banner fires, and
mark the offending step in the Questions panel rather than leaving it silently inert.

### A7. A failed union silently discards an elimination **[R]**
`src/tools.js:469`

`removed = safeUnion(removed, elims[i]) || removed` — and `safeUnion` already swallows its
exception and returns `null`. So a union failure drops that step's **entire** eliminated
region from the mask. Nothing throws; no banner. The board shows area as still-possible
that a question ruled out.

**Change:** treat a null union as a failure — surface it via the banner instead of the
`|| removed` fallback that hides it.

### A8. The candidate filter leaves a hidden item checked **[V]**
`src/layers.js:385` (`_featureListHTML`) · `src/layers.js:394` (`_wireFeatureSearch`)

`_featureListHTML` marks `i === 0` checked; the filter only sets `display: none` and never
touches `checked`. Type "Waterloo", see only Waterloo, assume filtering selected it, hit
Add → `featureIndex 0` is recorded — a different, hidden station. The wrong question is
committed silently, and `describeStep` then reports the wrong name.

**Change:** on filter, clear the selection when the checked item is hidden, and require an
explicit pick (or auto-select the sole visible match). Directly blocks the
type-a-preference flow in §B.

### A9. Zero, negative, and non-numeric silently become 10 **[R]**
`src/layers.js:704` (Radar radius) · `src/layers.js:1209` (Measuring distance)

`Math.max(10, parseFloat(...) || 0)` turns `"0"`, `"-500"` and `"abc"` all into `10` with
no feedback; the "question added" toast fires as if the typed value were honoured. A hider
standing on the reference ("0 m") is a legitimate answer that gets silently rewritten.

**Change:** validate and reject rather than clamp — surface the bad input in the sheet and
allow a genuine 0.

---

## B. Data completeness — the exhaustive station list

The infrastructure already exists. `server.js:73` is a working Overpass proxy with
three-endpoint failover and backoff; `CATEGORY_TAGS` already maps `train_station` and
`subway_station`; `normalize` (`server.js:130`) returns **every** element in the bbox,
uncapped and de-duped. This is a rewiring job, not a build.

### B1. Pagination fires 400 ms too early → exactly 20 results **[V]**
`src/places.js:151`

The code contradicts its own comment:

```js
// The next-page token needs ~2 s to activate; calling too soon errors.
setTimeout(() => pagination.nextPage(), 1600);
```

When the token isn't ready, `nextPage()` returns `INVALID_REQUEST`, and the fallback at
`places.js:157` (`else if (all.length) resolve(all)`) quietly resolves page one. **This is
the likely proximate cause of the "most lists only contain 20 elements" symptom** — not
the 60-cap.

**Change:** raise the delay past 2 s, and retry once on `INVALID_REQUEST` before giving
up. Do not let a page-2 failure masquerade as a complete result.

### B2. `THIN = 2` makes the exhaustive source unreachable **[V]**
`src/places.js:224`

`searchCategoryResilient` returns early on `!googleErr && feats.length >= THIN`. Google's
`nearbySearch` hard-caps at 60. In London, Google returns its 60-station cap, `60 >= 2`,
and the ~400-station OSM dataset is never consulted. Overpass only ever fires on API
*failure*, never for *completeness*. This is the architectural root of the ceiling.

**Change:** invert the priority for station/POI-dense cards — query Overpass over the play
area first and treat Google as the fallback. Every mature tool in this space made the same
call, for the same reason: Overpass queries a *region*, not a radius-around-a-point, so it
has no top-N cap — only a timeout.

**Confirmed by the §G1 spike (2026-07-15):** a Mumbai bbox returned 75 route relations and
7115 ways with no cap of any kind. The "no top-N limit" premise is measured, not assumed.

> **⚠ Read D3 before building this.** The same spike measured public Overpass failing
> **roughly half of all attempts** (HTTP 504, and HTTP 200 with an HTML error body). Today
> that's invisible — Overpass is a fallback that only runs when Google has *already*
> failed, so a flaky retry costs nothing. **Inverting the priority moves a ~50%-transient-failure
> dependency onto the critical path of the most common action in the app.** That does not
> make B2 wrong — the failures are transient and every one cleared on retry — but B2 is not
> "swap the order of two calls". It ships with D3's retry/backoff hardening, or the
> exhaustive-station feature will feel worse than the capped one it replaced.

### B3. Station's Name Length is silently wrong in any dense metro **[V]**
`src/layers.js:858`

Calls `searchCategory` (not `searchCategoryResilient`), so it is capped at 60 stations for
the entire board with no OSM fallback, and partitions from an arbitrary subset — both
"same" and "different" answers eliminate the wrong regions, with no indication anything
was truncated. It is also the only POI card that skips `_assembleCandidates`, so a seeker
cannot add the station they actually mean.

**Change:** route it through the resilient path and give it the standard candidate picker.

### B4. `searchText` never paginates **[V]**
`src/places.js:30`

`svc.textSearch` is called with a plain callback that ignores the third `pagination`
argument, unlike `searchCategory`. Every text search is capped at Google's first page of
20; the match the seeker wants may be at rank 21+ and is unreachable. `features.js:242`
then slices that to 8.

**Change:** paginate as `searchCategory` does, with the corrected delay from B1.

### B5. Auto-find silently covers only a 50 km disc **[V]**
`src/layers.js:750` (`_searchParams`)

`Math.min(50000, Math.max(500, (diag/2)*1.2))` — Google's hard maximum. On a board with a
>100 km diagonal, POIs near the edges are never found and the partition is wrong, with no
warning that the search did not span the area.

**Change:** moot once B2 lands for the affected cards (Overpass takes a polygon, not a
radius). Until then, warn when the clamp binds.

### B6. The Overpass fallback ignores the caller's centre and radius **[R]**
`src/places.js:228` — bbox from `areaBboxSWNE(gameArea, padMeters)` (`places.js:192`)

A 2 km Museums tentacle on a 300 km board falls back to a query spanning the **entire**
play area, which can time out; the failure is swallowed at `places.js:236` (`console.warn`
only) and the caller silently receives an empty candidate list.

**Change:** pass the caller's centre/radius through and derive the bbox from *that*, not
from the whole game area.

### B7. Type-a-station-name resolution (the feature ask)

Once B1–B3 land, the complete station set is in memory, so this is a pure client-side
filter with no extra round trip: fuzzy-match the typed name against the local list, show
matches, and fall through to the existing Google text-search flow only when there is no
local hit. **A8 must be fixed first** — as it stands, typing a preference is actively
dangerous.

---

## C. State and persistence

### C1. `importGame` overwrites the game it shares an id with **[V]**
`src/store.js:151`

`normalizeGame` → `createGame({...obj})` → `id: overrides.id || uid('game')` keeps the
source id, then `db.put('games', g)` writes over the record already at that key. Export
mid-session, play three more questions, re-import to compare → the import silently
destroys the three questions. `duplicate()` (`games.js:143`) does this correctly by
stripping `id` first.

**Change:** always mint a fresh id on import; keep the original as `importedFrom` if
provenance matters.

### C2. Redo dies on reload **[R]**
`src/layers.js:56` — absent from the schema at `src/model.js:25`

`redoStack` is instance state. Undo a question, reload before pressing Redo, and
`canRedo` (`layers.js:548`) is permanently false for that step. It survives as
`enabled:false`, but only a manual checkbox toggle recovers it — silently changing the
recovery path the UI advertises.

**Change:** persist the redo stack on the game record, or derive redo from the
most-recently-disabled step.

### C3. Removing every zone orphans the guides **[R]**
`src/zones.js:124` (`removeZone`) vs `src/layers.js:159` (`_render` guide loop)

`removeZone` recomputes `gameArea = unionRings([])` → `null` but never touches
`g.history`. The mask block is guarded by `if (g.gameArea)`; the guide loop below it is
not. Radar circles and bisectors float on a map with no shading context.

**Change:** guard the guide loop on `g.gameArea` too, or prompt when zones are removed
while enabled questions remain.

### C4. Transit desyncs from its toolbar button on game switch **[V]**
`src/app.js:183` vs `src/app.js:190`

The game-switch subscriber calls `features.clearAll()`, which does
`this.transit.setMap(null)`. Nothing removes the `.active` class. After opening a game
from history the button reads on while the layer is off, and one tap "toggles it off"
(actually turning it on). Phase 22 made transit on-by-default; a game switch silently
reverts that.

**Change:** either exclude transit from `clearAll` (it isn't per-game state), or re-apply
the default and sync the class after a switch.

---

## D. Robustness

### D1. Hand-drawn polygons are never validated **[R]**
`src/layers.js:306` (`_drawShape`)

Checks point count and nothing else — no `turf.kinks` or `booleanValid` anywhere in
`src/`. A self-crossing "Body of Water" flows into `bufferGeometry` (`tools.js:406`),
which catches the throw and returns `null` → zero elimination. The "question added" toast
(`layers.js:1213`, `layers.js:953`) fires unconditionally, so the seeker never learns the
question did nothing.

**Change:** validate on finish with `turf.kinks`, and refuse to commit (or offer to
auto-fix) a self-intersecting ring.

### D2. No antimeridian handling in the coordinate pipeline **[R]**
`src/geo.js:12` (`ringToTurf`) · `src/geo.js:57` (`unionRings`) · `src/zones.js:91` · `src/tools.js:188`

`LatLng.lng()` is normalised to [-180,180] with no unwrapping anywhere before the values
reach turf. A zone straddling ±180° makes `unionRings` return `null` → `gameArea` is null
→ every tool reports "Add a zone first (Zones ▸ Draw)" **after a zone was added**.
Edge-case for realistic play areas, but the message actively misleads.

**Change:** low priority. At minimum, distinguish "union failed" from "no zones" in the
guard message so the failure is diagnosable.

### D3. The Overpass proxy mis-detects a busy endpoint as a parse error **[V — measured]**
`server.js:109` (`runOverpass`) · `server.js:119` (the `resp.ok` check) · `server.js:123` (backoff)

Measured across ~10 live spike calls on 2026-07-15, **roughly half failed**. Two distinct
failure shapes, and the second is the problem:

- **HTTP 504 with an HTML body** — caught correctly by `if (!resp.ok)`.
- **HTTP 200 with an HTML body** — *not* caught. Overpass answers `200` and puts the error
  in the payload: `Error: runtime error: open64: 0 Success /osm3s_osm_base
  Dispatcher_Client::request_read_and_idx::timeout. The server is probably too busy to
  handle your request.` `resp.ok` is true, so it falls through to `resp.json()` and throws
  `SyntaxError: Unexpected token '<'`.

The failover *does* catch the throw and try the next endpoint, so **this is not a
correctness bug today** — every failure cleared on retry. Two real consequences anyway:

1. **The log lies.** `console.error("Overpass proxy failed:", err.message)` (`server.js:93`)
   reports `Unexpected token '<'` — which reads like a code defect — when the true cause is
   "the endpoint was busy, try again". Debugging this in six months from the log alone
   would be genuinely misleading.
2. **The backoff is an order of magnitude short.** `500 * (i+1)` gives 0.5 s then 1 s
   (`server.js:123`), then the endpoint list is exhausted and the request fails for good.
   The spike needed multi-second waits and several rounds before an endpoint answered.

**Change:** sniff the body before parsing — if it doesn't start with `{`, treat it as a
busy-signal, not a parse error, and log it as such. Lengthen the backoff and allow more
than one pass over the endpoint list. **Priority is coupled to B2:** as a fallback this is
cosmetic; the moment B2 makes Overpass primary it is on the critical path, and §G1's rail
queries are heavier than POI queries, so busy-responses get *more* likely, not less.

### E1. `data/linear.js` is a documented feature that was never wired **[V]**
`src/data/linear.js` · `README.md:35` · `src/layers.js:1269`

README claimsa the pp "Ships approximate Mumbai coastline + Western Railway GeoJSON" for
the Measuring tool, and the module header says linear features "can't come from the Places
API, so a small dataset ships with the app". But `_measureLine` unconditionally calls
`_drawShape(2, ...)` — the data exists, the README promises it, no code path reaches it.

**Change:** either wire it as a pick-a-bundled-line option in `_measureLine`, or delete it
and correct the README. Related idea from the research: a bundled simplified Natural Earth
coastline generalises this beyond Mumbai.

**Done 2026-07-16 — deleted.** Took the delete option, and the brief settled it rather than
taste: *"the exact lines used automatically, without my input. mumbai should not have an
advantage in any stage."* Wiring the module would have done the opposite — it is Mumbai-only
and hand-traced, so wiring it hands Mumbai two accurate reference lines and every other board
nothing. §5.6/G1 sources coastline, rail and borders from Overpass worldwide instead.

Confirmed dead before deleting, not assumed: `LINEAR_FEATURES` had **no importer anywhere** —
its only two references were the module's own `findLinear` helper and the service-worker
precache list. The `ref: "line"` cards (coastline, rail, borders) are all hand-drawn today via
`_drawShape` (`layers.js:1495`), which is why no path reached the data.

Corrected alongside: `README.md:34-35` (promised the bundled GeoJSON by filename),
`GUIDE.md` §Phase 4 (planned it) and the §5.4 difficulty note (still suggested bundling as the
answer). `service-worker.js` SHELL_ASSETS entry removed and `CACHE_VERSION` bumped to v60 —
`cache.addAll` is atomic, so leaving the entry would have failed every SW install silently.
That coupling has now bitten twice (E2, then E1), so `test/shell-assets.test.mjs` enforces it.

### E2. `i18n.js` and `langs/en.js` are dead but precached **[V]**
`src/i18n.js` · `src/langs/en.js` · `service-worker.js:22`

Zero importers outside the files themselves (~70 lines). Both are in `SHELL_ASSETS`, so
`cache.addAll` fetches them on every install — and since `addAll` is atomic, a rename or
delete without a matching manifest edit fails the whole SW install.

**Change:** delete both and their `SHELL_ASSETS` entries together.

### E3. `Focus.point()` is dead **[V]**
`src/focus.js:28` — no call sites

Left over from the removed hider/multiplayer flow (3f2ce4b). **Change:** delete.

### E4. The Socket.IO relay outlived its client — *recorded only, not for now* **[V]**
`server.js:19`, `server.js:148-206` · `package.json`

3f2ce4b removed `src/sync.js` and all client sync, but the server still imports socket.io
and hosts the session/relay handlers with no client that speaks to them. `package.json`
still declares `socket.io: ^4.8.3` and describes itself as the "Phase 13 realtime relay".
Dead surface shipping to Render plus an unused dependency.

**Change:** none now — multiplayer is out of scope. Revisit when that decision changes.

### E5. Every renderer double-renders at boot **[V]**
`src/layers.js:61` · `src/zones.js:32` · `src/focus.js:21`

`store.subscribe` already invokes the callback synchronously when `current` exists
(`store.js:22`); all three then call `this.render()` again. Every overlay is built, torn
down and rebuilt — on a country-scale area that's a duplicated `turf.difference` plus a
full Google Polygon rebuild for nothing.

**Change:** drop the redundant explicit `render()` calls.

### E6. `GUIDE.md` §5.5 documents the superseded Tentacles model **[R]**

Still describes the old "enumerate all features in the region" model; `tools.js:309-368`
implements the Phase 18 seeker-radius model. The question bank (`docs/jetlag_questions.md`)
matches the implementation 1:1 — only the design doc is stale.

**Change:** update §5.5.

### E7. `_chooseTentacle` has no add-candidate escape hatch **[R]**
`src/layers.js:1115`

If the hider names a POI absent from the auto-found list, Cancel discards the whole
sub-flow and the seeker must restart from `startTentacles`. Recoverable, not a dead end —
but it's friction on the exact flow §B7 is meant to smooth.

**Change:** add an "add candidate" button that re-enters `_assembleCandidates` in place.

---

## F. Transit line data — the trap you haven't hit, and the one you have

The research surfaced a trap that broke the flagship OSM-based tool in production. **It
cannot bite you today** — but the reason why is itself a finding, and the trap becomes
live the moment §B2 makes Overpass primary.

### F0. Why you're currently immune **[V]**
`src/data/questions.js:41` · `src/data/questions.js:37`

`transit_line` and `street` use `mode: "nearestLine"`, and the seeker **hand-draws** each
line by tapping (`_matchNearestLine`, `src/layers.js:894`). The module comment states the
reason plainly: *"no Google geometry"*. Google's Maps JS API exposes **no queryable
transit line geometry at all** — `TransitLayer` (`src/features.js:37`, the app's only use
of it) is a raster tile overlay, purely visual, with nothing to query. So you're immune to
an OSM tagging trap by virtue of not consuming OSM line data — or any line data.

That immunity is bought with manual tracing, and it has its own cost (F1, F2).

### F1. "Metro Lines" answers a different question than the card asks **[V]**
`src/data/questions.js:20` · `src/tools.js:309`

The Tentacles card is **Metro Lines**, but it's sourced as `type: "subway_station"` and
partitioned as a Voronoi over metro *stations*. The file is honest about it
(`approx: "via metro stations"`, and the header comment: *"stations sit on the lines — an
automatic approximation"*), but the failure mode isn't obvious from that label:

> Lines A and B run parallel a few hundred metres apart. The hider stands beside line A,
> mid-way between its stations. The nearest *station* is on line B. The station-Voronoi
> puts them in B's cell. The hider truthfully answers "closest to line A" — and the seeker
> cannot record that answer correctly, or records it and eliminates the hider's real
> location.

Stations sit on lines, but "nearest station" ≠ "nearest line" wherever station spacing
exceeds line spacing — i.e. exactly in the dense metro cores where this card gets played.
This is the same *class* of error as the OSM trap (a proxy standing in for line
membership), arrived at from the opposite direction.

**Change, updated 2026-07-15:** **G1 is now the real fix, and it's verified.** The spike
returned Mumbai's Metro Line 1 and Line 3 as named geometry, which is exactly what this card
needs to stop approximating — partition by the *line*, not by a Voronoi over its stations.
That makes F1 a scheduled fix rather than an open question, and this card G1's best first
customer. (It was F4 that was going to fix this; F4 is superseded.)

**Until G1 lands**, the honest interim is to surface the approximation *at the point of use* —
warn in `_chooseTentacle` that the partition is by station, not line, so the seeker knows when
to distrust it. That warning is cheap and shouldn't wait for G1.

### F2. Hand-drawn lines are sampled at 400 m **[V]**
`src/tools.js:249` · `src/tools.js:196` (`densifyLine`)

`matchingNearestLine` densifies each drawn line to points every 400 m and takes a point
Voronoi over the union. So the "nearest line" boundary is accurate to roughly ±200 m at
best, before counting tracing error. Acceptable for a city board; meaningful on a card
where two lines run close together — the same geometry as F1.

**Change:** make `stepMeters` scale with the board size (finer for small areas), or
sample adaptively near where lines converge. Cheap, and it tightens the one question type
that currently has no automatic source at all.

**Done 2026-07-16** — `lineStepMeters(gameArea)` = 1% of the board diagonal, clamped to
[25 m, 400 m]. Took the scaling option, not adaptive sampling: adaptive costs a
convergence-detection pass and this needed none. Because total line length grows with the
board, a board-relative step holds the sample *count* roughly constant too — so small boards
get finer without large boards getting slower. Bounds are judgement and are stated in the
code: 25 m because these lines are finger-traced on a phone and below that tracing error
dominates; 400 m because that was the old value and this should never be coarser than what
it replaced.

Worth recording precisely, because it's sharper than "±200 m": the real failure isn't coarse
sampling, it's **phase**. Two lines 150 m apart, probe 60 m from A and 90 m from B. At a 400 m
step, B's samples land out of phase with A's, so B's nearest sample is **91 m** from the probe
while A's own nearest sample is **222 m** — the probe is handed to B, and answering "nearest A"
truthfully gets the hider's real location eliminated. Same geometry as F1, arrived at from the
sampling side. `test/line-step.test.mjs` reproduces exactly that, and keeps a large-board case
pinned at the 400 m ceiling so the old behaviour stays visible rather than deleted.

### F3. The OSM trap — deferred, but write the fix down now **[R]**

If §B2 lands and Overpass becomes primary, auto-sourcing transit lines becomes tempting.
The flagship tool tried it via OSM route-relation membership and it broke in production
(their issues #61, #172) for two reasons:

- **Some networks tag the entire system as one relation** — the whole DC Metro comes back
  as "one line", so every station matches every other and the question never discriminates.
- **Stop-node IDs referenced by route relations often don't match the `railway=station`
  node IDs** used elsewhere, so pure ID comparison produces false "different" answers.

Their fix — worth copying verbatim rather than rediscovering — replaces the single ID
check with a **union of signals**, any one of which counts as "same line":

```
nodeIdMatch
  OR haversine(station, nearestRouteStop) < 250 m
  OR normalizeName(a) === normalizeName(b)
  OR gtfsLineRefMatch          // fallback tiebreaker only
```

…then inverts the whole predicate for "different". Note the shape of that: OSM stays
primary for *station existence*, and GTFS is a secondary corroboration signal for the
*hardest sub-problem only*. Don't reach for GTFS wholesale.

**Spike data point (2026-07-15) — one city, not a clearance.** Mumbai did *not* show the
one-mega-relation shape: 75 discrete, well-named relations (only 2 of 75 unnamed), with lines
mapped per direction and per fast/slow service. So the first bullet's failure mode is absent
*here*. **That is one city and proves nothing about DC**, which is where it was actually
reported — and the fact that Mumbai looks clean is exactly how the flagship tool got caught:
the naive version works until it meets the network that's tagged differently.

**Status change:** this is no longer a hypothetical. F3 was filed as "deferred until B2 makes
Overpass primary" — **G1 is now verified and consumes OSM line data directly**, so the moment
G1 ships, line data is live in the app. G1 alone doesn't trip the trap (drawing lines needs no
station↔line membership test), but F1's real fix and any "same line?" question do.

**Change:** still nothing to build now. But when line auto-sourcing happens, build it
multi-signal from day one — the flagship shipped the naive version and had to patch it after
two separate playtests broke. Do not treat Mumbai's clean data as evidence the naive version
is fine.

### F4. A Google-native line-geometry option — **SUPERSEDED by G1; keep only as a fallback**
`src/features.js:20` (DirectionsService already wired)

> **Status changed 2026-07-15.** This was written when there was *no* proven source of line
> geometry, which made an untested Google-native idea worth a spike. **G1 has now been run and
> works**, and it beats this on every axis that mattered here: no licensing question (ODbL
> permits caching, which this design *requires*), no per-line API cost, no dependence on
> routing staying on a single line, no need to know each line's endpoint stations, and it
> works offline. **Do not spike F4 first.** It is only worth revisiting if G1's OSM coverage
> turns out to be poor in a specific play city — a Google-shaped fallback for a data gap,
> not the primary plan. The rest of this item is preserved for that case.

There may be a path to real line geometry from the API you already pay for, without
Overpass or GTFS. A Directions request with `travelMode: TRANSIT` returns steps, and each
transit step carries both `transit.line` metadata (name, short_name, agency, vehicle) and
an encoded `polyline` of that leg's actual path. So:

1. Route TRANSIT between two stations known to be on the target line.
2. Keep the steps where `step.transit.line.name` (or `short_name`) matches the line.
3. Decode with `google.maps.geometry.encoding.decodePath` into the same `{lat,lng}[]`
   shape `nearestLine` already consumes — no changes needed downstream of `inputs.lines`.

If it works, it replaces hand-tracing for `transit_line` and gives F1 a real fix, using
`DirectionsService` which `MapFeatures.init` already constructs.

**Caveats, honestly:** I have not tested any of this. The routing may transfer across
lines rather than staying on one; you need the line's endpoint stations to route between;
transit coverage varies by city; and it costs one Directions call per line. There is also
a licensing question — the app persists `inputs.lines` to IndexedDB indefinitely, and
Google's terms restrict caching Directions content; **check the current terms before
building on this**, since the whole design depends on storing the derived path.

**Change:** none — G1 supersedes this. If G1's coverage disappoints in a real play city,
timebox a spike then. Either way F0's hand-drawing stays correct as the floor — just manual.

---

## G. Showing rail lines on the map (Mumbai locals problem)

**Ask:** train lines should be visible on the map — not just metros. In Mumbai the transit
layer shows the Metro but not the suburban locals (Western / Central / Harbour), which are
the lines that actually matter for the game. Colour is not required; lines + stations is
the whole requirement.

### G0. Why the transit layer can't be fixed from Google's side **[V]**
`src/features.js:37` — the app's only Google transit surface

`google.maps.TransitLayer` renders **raster tiles** drawn from Google's own transit feed
inventory. Two consequences, both hard:

- **Coverage is agency-by-agency.** The layer draws what Google has a feed for. Your
  observation is consistent with Mumbai Metro supplying data and Indian Railways'
  suburban network not being in Google's layer inventory — the Metro draws, the locals
  don't. *(Likely explanation, not verified — I have no view of Google's feed inventory.)*
- **There is no knob.** `TransitLayer` takes no options. You cannot add an agency, restyle
  it, filter it, or query it. It is pixels. There is no Google-side fix for a missing
  agency, and no amount of API work changes that.

So this needs a data source outside Google. Two candidates, and the cheap one has a catch.

### G1. Recommended: rail geometry from Overpass via the proxy you already own — **SPIKE RUN, numbers below [V]**
`server.js:73` (proxy) · `server.js:98` (`buildQuery`) · `server.js:105` (`out center tags`) · `server.js:130` (`normalize`)

You already run an Overpass proxy on Render with three-endpoint failover. This is the same
infrastructure §B2 wants to promote anyway, so it's a rewiring job, not a build.

The naive query (`way["railway"="rail"]`) is the wrong one — every siding, yard, spur and
freight stub, thousands of segments. **Query route relations instead**: curated *passenger*
routes, and they carry names.

**This was run for real on 2026-07-15** against `overpass-api.de`, Mumbai bbox
`18.90,72.75,19.30,73.05`. Everything below is measured, not predicted. It contradicts
three things I originally wrote here — the corrections are marked.

#### What came back — the premise holds

75 route relations: **56 `route=train`, 16 `route=subway`**. The named suburban network is
all there — *Western Line (fast/slow), Central Line (Kalyan/Kasara/Khopoli), Harbour Line,
Trans-Harbour Line, Nerul–Uran Line*, plus *Metro Line 1 / Line 3*. **These are exactly the
lines Google's TransitLayer omits.** The premise of this whole section is confirmed: OSM has
what Google doesn't, and it's well mapped. Only 2 of 75 were unnamed.

#### CORRECTION 1 — do NOT filter by tag; clip to the board instead

The intercity problem is real: 18 relations are long-distance expresses
(*"Train 12619 Matsyagandha Superfast Express"* → Mangaluru, *"Train 19058"* → Surat).
`relation(bbox)` returns their **whole** geometry, so a naive render draws lines across India.

The tempting fix is filtering `passenger=suburban`. **That is a worldwide-correctness trap.**
Measured tag distribution:

| `passenger` | count | | `service` | count |
|---|---|---|---|---|
| `(absent)` | 24 | | `(absent)` | 59 |
| `suburban` | 25 | | `commuter` | 13 |
| `national` | 18 | | | |
| `regional` | 4 | | | |
| `main` | 1 | | | |

**24 relations have no `passenger` tag at all** — a tag filter would silently drop those, and
OSM tagging conventions vary by country, so the set it drops would differ everywhere. It'd
look fine in Mumbai and quietly lose lines in Osaka.

**Clip geometry to the play area instead.** It's tag-independent, so it works worldwide with
no per-country tuning, and it's *semantically right*: an express contributes only the segment
inside the board, which is correct — that track is there and a hider can ride it. The clip is
also what makes the payload viable (see below).

#### CORRECTION 2 — `way(r)` already dedups; the name-dedup advice was wrong

I previously wrote "dedup by name — routes are mapped once per direction, you'll double-draw."
**Measured: 7115 elements returned, 7115 unique way ids — duplication factor 1.0×.** Overpass
returns a *set*, so `way(r)` collapses the shared track of Western Line fast/slow/both-directions
automatically. There is no name-dedup step to write.

This matters for the render: **dedup at the way level, not the name level.** Each physical
track is already one way, drawn once — which is exactly what a uniform bold stroke needs, with
no blotchy overlap where six relations share rails. And since we aren't drawing labels, the
name-collision problem disappears entirely.

#### The payload — why the clip is mandatory

| stage | size |
|---|---|
| raw `out geom` response | **8.3 MB** |
| unique member ways | 7115 (87 506 vertices) |
| **ways actually touching the bbox** | **947** (12 747 vertices) |
| slimmed JSON (5-dp coords) | 248 KB |
| gzipped | **66 KB** |

**Only 947 of 7115 ways touch the play area — 87% of that 8.3 MB is track running off to
Mangaluru and Surat.** Clipped and slimmed it's 66 KB on the wire, which is entirely fine for
a phone. Unclipped it is not.

Untested idea worth trying first, since it'd push the clip to Overpass and avoid pulling 8.3 MB
into the proxy at all:

```
[out:json][timeout:90];
relation["route"~"^(train|subway|light_rail|tram|monorail)$"](BBOX)->.r;
way(r)(BBOX);
out geom;
```

I did not get to run this one. If it works it's strictly better; if not, clip in `normalize()`.

#### CORRECTION 4 (2026-07-16) — ran it. The idea is right; **the query above is broken.**

Measured, not reasoned. Two separate results:

**(a) The proposed query silently returns nothing.** Run verbatim it yields **0 ways** — in Mumbai
*and* in Berlin, which has one of Europe's densest rail networks. The cause is the recursion input
set: `->.r` stores the relations in the named set `.r`, but `way(r)` recurses down from the
**default** set `_`, which is now empty. A control query proves the selector was never at fault:

| variant (Berlin, same bbox) | elements | verts | bytes |
|---|---|---|---|
| `relation[route~…](BBOX); out ids;` (control) | **208** | — | 7 KB |
| the proposed query, verbatim | **0** | 0 | 247 B |
| `way(r.r)(BBOX)` — name the set | **5 477** | 46 095 | 4.4 MB |
| `way(r)(BBOX)` — relations left in `_` | **5 477** | 46 095 | 4.4 MB |

208 route relations match; the recursion dropped all of them. Overpass returns HTTP 200 with
well-formed JSON and an empty `elements` array, so **nothing raises** — this would have shipped a
rail layer that draws nothing on every board, forever, with no error. That is the exact silent-
failure class §A exists to remove, which is why it's worth a table.

Both fixes work identically. **Use `way(r.r)`**: naming the set makes the bug impossible to
reintroduce, whereas `way(r)` is only correct by the accident of what happens to sit in `_`.

**(b) With the syntax fixed, the server clip is lossless and mandatory.**

| bbox | clipped | whole | ratio |
|---|---|---|---|
| Mumbai | 806 ways · 813 KB · 1.9 s | 5 489 ways · 4 974 KB · 2.2 s | 6.1× |
| Berlin | 5 477 ways · 4 329 KB · 5.4 s | 36 293 ways · **34 194 KB** · **33.9 s** | 7.9× |
| London | 5 592 ways · 4 797 KB · 8.1 s | 42 014 ways · **37 471 KB** · **32.9 s** | 7.8× |

All three cases: `droppedByServerClip: 0`, `truncatedWays: 0`. So the clip **keeps every way a
client-side clip would have kept, and returns each one whole rather than cutting it at the box
edge** — lines don't render truncated at the board boundary, and there's no geometry to
reconstruct. It is strictly better, as suspected.

It's also not optional. Berlin and London unclipped are **34–37 MB at ~33 s**, against a 45 s
fetch timeout — one dense board away from timing out, and all of it would sit in proxy memory.
Clip server-side.

Note for the build: even *clipped*, dense-tram cities are chunky (Berlin/London ≈ 4.3–4.8 MB raw),
where Mumbai is 813 KB. Slimming (5-dp coords, drop tags) is what makes those viable, not the clip
alone. Whether `tram` belongs in the route set at all is a **game-design** question, not a
technical one — trams run on streets, and the brief was "everything except streets". Left in for
now to match the doc; flagged rather than silently decided.

#### Still true from before

- **`out geom` is the whole point.** `server.js:105` hardcodes `out center tags;`, which
  collapses every way to a centre point — fine for POIs, useless for lines. Needs a new
  endpoint or a `geom=1` mode plus a `normalizeLines()` returning
  `[{name, ref, coords:[[lat,lng],…]}]`.
- **Keep names in the payload even though the map won't show them.** Not for rendering —
  for §F4 (`nearestLine`), which needs named geometry in exactly this shape. Free to carry.
- **Cache hard.** Rail geometry is effectively static — cache per bbox in IndexedDB and it
  survives offline, which a tile overlay never will.

#### CORRECTION 5 (2026-07-16) — names are NOT free, and the payload shape above is wrong

Both corrections come from building it. The endpoint (`GET /overpass/lines`) is live.

**Names cost a query step, and it's the cheapest of three options.** `out geom` on a *way*
carries the **way's** tags, never the parent relation's name — so naming the geometry needs the
relation→way membership, which means a second output step. Measured:

| approach | Mumbai | Berlin | geometry duplicated? | names? |
|---|---|---|---|---|
| `way(r.r)(BBOX); out geom;` alone | 813 KB | 4 329 KB | no | **no** |
| **`.r out body;` + clipped ways, joined** | **1 362 KB** | **8 475 KB** | **no** | yes |
| `out geom(BBOX)` on the relations | 1 427 KB | 10 500 KB | **yes, 3.5×** | yes |

`out geom(BBOX)` looks ideal — names and clipped geometry in one pass, no join — and it does
work. It's still the worst option: it emits every member ref regardless *and* repeats shared way
geometry once per relation (Berlin: 19 720 member-geoms for 5 605 unique ways). The join wins on
size *and* keeps the de-duplication the render depends on.

The cost is real but lands server-side only: Berlin ships ~93 k member refs to use ~19 k. The
proxy does the join and the slimming, so none of it crosses the wire. Measured on a live Mumbai
bbox: **303 KB of raw Overpass → a 30.7 KB response.**

**The `[{name, ref, coords}]` shape is rejected — it serves one consumer and hurts the other.**
Shipped shape:

```json
{ "kind":"rail",
  "lines":[{ "name":"Western Line (fast): Virar => Churchgate", "ref":"W", "wayIds":[49180854, …] }],
  "ways": { "49180854":[[19.13028,72.82139], …] },
  "counts":{ "lines":21, "ways":45, "vertices":1397 } }
```

Geometry lives **once** in `ways`; `lines` reference it by id. Inlining coords per line repeats
shared rails — Berlin 142 329 vertices against 46 095 unique, **3×** — and draws them 3.5 deep,
which is precisely the blotchy overlap CORRECTION 2 warns about. This shape gives the render
unique ways to stroke once, gives §F4/§F1 lossless per-line grouping via `wayIds`, and costs a
third of the payload. No consumer has to de-dupe.

**Two things the real data taught that a written fixture wouldn't have:** route relations list
their stops as members (`{type:"node", role:"stop"}`) mixed in with the ways, so the member
filter must test `type`, not presence; and most member refs point outside the bbox and must not
join. `test/overpass-lines.test.mjs` runs against captured real responses for that reason.

Verified live, all three kinds: rail returns the Harbour and Western locals **by name** — the
exact lines Google's transit layer omits; `border&level=4` returns *Gujarat, Maharashtra, Dadra
and Nagar Haveli and Daman and Diu*; `border&level=2` on the same box returns zero lines, which
is correct (no international border crosses it) and is distinguishable from an outage, since a
busy Overpass is a 502.

#### DONE 2026-07-16 — the client half, verified in the browser

`src/lines.js` (fetch + IndexedDB cache + render), a 🚄 Rail toolbar toggle, `lines` store at
`DB_VERSION` 4. Run against a real Mumbai board (`19.029,72.79,19.161,72.91`):

- **49 lines, 230 segments, 4 702 vertices, 102 KB** — and the list is the ask, met: *Western
  Line (fast/slow, both directions)*, *Central Line (fast/slow, to Kalyan / Kasara / Khopoli)*,
  *Harbour Line (CSMT→Panvel, CSMT→Goregaon)*, alongside Metro Lines 1/2/2B/3/7/11. The
  suburban locals draw. That was the whole §G ask.
- 230 polylines attached, **all at zIndex 0** (under `MASK_BASE`'s 1), uniform weight 3, one
  colour. Track outside the board dims under the mask rather than stopping dead at the edge.
- Toggle off clears every overlay; second load **26 ms** from IndexedDB against a multi-second
  Overpass fetch. Zero console errors.
- 1 514 drawn vertices fall outside the board bbox — **not a bug, it's `truncatedWays: 0`
  showing up in the browser.** Ways that cross the edge come back whole, so lines continue
  off-board under the shading instead of being clipped mid-air.

The cache ladder is cache → network → **stale cache**. The last rung matters more than it
looks: this is played outdoors, ~64% of individual Overpass calls fail, and a month-old rail
line beats a blank map — with a toast that says it's an offline copy. A tile overlay cannot do
that at all, which is §G2's other problem beyond the licence.

**Still open (deliberately):** `lines[].wayIds` is carried and tested but has no consumer yet —
it exists so **F1/F4** can partition by *line* instead of by a Voronoi over stations. Wiring
that is the next step, and it retires F1 rather than adding to it. Coastline and border are
served by the endpoint and fetchable, but only rail has a toolbar button so far.

#### CORRECTION 3 — Overpass reliability is worse than the proxy assumes → **now filed as D3**

The spike found public Overpass failing ~half the time, including an HTTP-200-with-HTML-body
case that `runOverpass` mis-reports as a parse error. This turned out to be bigger than §G —
it lands on **§B2**'s critical path once Overpass goes primary — so it's written up as its own
item, **D3**, rather than buried here. Read D3 before building either B2 or G1.

### G2. Faster alternative: OpenRailwayMap tile overlay — **licensing blocker, read this** **[V]**

~20 lines, no backend work, global coverage, works today:

```js
const rail = new google.maps.ImageMapType({
  getTileUrl: (c, z) => `https://tiles.openrailwaymap.org/standard/${z}/${c.x}/${c.y}.png`,
  tileSize: new google.maps.Size(256, 256),
  name: "Rail",
});
map.overlayMapTypes.push(rail);   // transparent PNGs, draws over the Google basemap
```

(The `(a|b|c).tiles.openrailwaymap.org` subdomain form you'll see in older examples is
**deprecated** and slated for removal — use the bare host above.)

**But their usage policy is a genuine constraint, not a formality.** Quoting it directly:

> "Small scale applications with few or relatively small requests are allowed to use the
> API and tiles free and without charge."
> "Applications accessing the tile or API have to be open to the public (free of charge
> and registration)."
> "Commercial projects and **non-public projects might be blocked without prior notice**."

Three problems for this app specifically:

1. **"Few requests" isn't what this is.** A seeker panning a city at z13–16 pulls hundreds
   of tiles per session. That is not the carve-out.
2. **"Open to the public" is arguable at best.** Your hosted build requires each user to
   supply their own Google Maps key before it works — a member of the public can't just
   open it and play. That reads closer to "non-public" than not.
3. **Blocked *without prior notice*** means the failure mode is the layer silently
   vanishing mid-game, with no warning and nothing you can do about it.

It also can't work offline (tiles are fetched live), gives you **pixels not geometry** so
it does nothing for §F, and requires CC-BY-SA attribution on-map (*Data ©
OpenStreetMap contributors, Style: CC-BY-SA 2.0 OpenRailwayMap*).

**Verdict:** fine as a personal 20-minute spike to see the lines tonight. Don't build on
it. The sanctioned path if you wanted to keep it is self-hosting the tile server — which
is strictly more work than G1, for a strictly worse result.

### G3. Why G1 is worth the extra work — it collapses §F **[V]**

The reason to prefer Overpass geometry over a picture is that **the same query answers
three open items**:

- **This ask** — draw the polylines, one bold uniform stroke, done.
- **F1 (Metro Lines proxy)** — the card is *Metro Lines* but partitions by `subway_station`
  Voronoi because "no queryable line geometry from Google". Route relations *are* that
  geometry — the spike returned Metro Line 1 and Line 3 by name. The proxy stops being
  necessary and the card becomes correct.
- **F4 (line geometry for `nearestLine`)** — named route geometry drops straight into
  `inputs.lines` as `[{id, label, coords}]`, the exact shape `_matchNearestLine` already
  builds by hand (`src/layers.js:894`). Hand-tracing becomes optional rather than
  mandatory, and F4's Directions-polyline spike — with its licensing question about
  persisting Directions content — becomes unnecessary. **This is why names stay in the
  payload despite never being drawn**: `label` is this field.

One query, one render path, and §F's three separate problems stop being problems. A tile
overlay buys the picture and nothing else.

**Suggested shape:** a toolbar toggle next to 🚆 Transit (say 🚄 Rail), rendering cached
Overpass polylines with `railway=station` nodes as small dots.

**Render decisions (settled 2026-07-15):**

- **Worldwide, not Mumbai-specific.** Nothing here is regional — route relations exist
  everywhere, and per CORRECTION 1 the clip-don't-filter approach is what keeps it that way.
  Mumbai is just the case that exposed the gap, because Google's feed happens to miss
  Indian Railways suburban.
- **No line names on the map.** Connectivity is the information; labels in a dense network
  are clutter you'd fight at every zoom. Names stay in the *payload* for §F4, off the
  *canvas*. This also deletes work rather than adding it — see CORRECTION 2.
- **One bold uniform stroke, no per-line colour.** Rail is the core premise of the game, so
  it should read at a glance. Bold is only legible because route relations are curated
  passenger lines — bolding `railway=rail` would give a hairball of yards and freight spurs.
  Draw *below* the elimination mask and guides so it never competes with game geometry.

---

## Suggested order

1. **§A** — the elimination engine should be trustworthy before anything is built on it.
   A1, A2, A3, A4 change game outcomes; A6 and A7 are why you'd never notice.
2. **B1** alone probably triples current list sizes for a one-line change.
3. **A8 → D3 → B2 → B3 → B7** — the exhaustive-station ask, in dependency order.
   **D3 moved into this chain on re-read**: B2 puts a dependency that fails ~half the time
   onto the critical path of the app's most common action, so harden the proxy *before*
   promoting it, not after the first bad game.
4. **§C**, then **§E** cleanup (E4 stays parked).
5. **§F** is mostly deferred — but **F1 is a live correctness gap**, not a future one, and
   deserves a warning at the point of use *now*, independent of everything else. F4 is
   superseded by G1 — don't spike it. F3 stays a note-to-self, but re-read it before any
   "same line?" work, since G1 makes OSM line data live.
6. **§G rides on B2.** Once Overpass is primary and the proxy learns `out geom`, G1 is a
   small increment — and it retires F1 and F4 rather than adding to them. The spike is
   **done** (G1) and the premise held; the one query still worth running before code is the
   Overpass-side clip under "The payload".
7. **Playtest 5 full games after all phases are complete** — not per-phase. The recurring
   theme of §A is that these failures are *silent*: nothing throws, the banner never fires,
   and a wrong elimination looks exactly like a right one. Only playing a whole game and
   sanity-checking the surviving area against the answers actually catches that class of
   bug. Vary the board deliberately across the five — city scale and country scale (A2 only
   bites at country scale), a run that eliminates everything (A1/A7), a Tentacles-heavy run
   (A4), and one on a dense rail network once §G lands.

## Workflow provenance

- Playthrough A (Tentacles/Matching, Sonnet 5) — A6, B6, C2, C3, D2, E6, E7.
- Playthrough B (Measuring/Radar, Sonnet 5) — A5, A7, A9, D1, E1 upgrade.
- Competitive research (3+ real tools) — see `docs/` or ask; key conclusion: every serious
  tool in this space abandoned commercial place-search for Overpass region queries, which
  independently corroborates B2.
