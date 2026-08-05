# Changelog

Built phase-by-phase per [`GUIDE.md`](GUIDE.md). Each entry is a completed, pushed phase.

---

# v2 major build (complete — all six phases)

A rebuild driven by [`MAPPER_ANALYSIS.md`](MAPPER_ANALYSIS.md) — a measured review of
[taibeled/JetLagHideAndSeek](https://github.com/taibeled/JetLagHideAndSeek), in which the
reference mapper was cloned, run, and driven through 40 scripted test games to establish
what it does well and where it is wrong. The improvement programme is §10 of that document;
the phases below follow its §10.8 order.

**The last stable v1 build (Phases 0–51) is the `v1-stable` branch.** Everything under this
heading is newer than that. All six phases are complete, plus the two §8.3 data-sourcing items
found outstanding in the completeness audit. The suite went 756 → 931 tests, the app boots and
its panels work in a browser, and five full games have been played through it end to end
(hider retained across all 24 turns).

**What has NOT happened is field play**: real GPS drift, real Overpass latency, a real phone in
a real city. Until that happens `v1-stable` remains the branch to actually play on.

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

## v2 Phase 3 — Hiding-zone engine (§10.3 items L, M, N, O)

The reference mapper's best idea, and the one this codebase was already closest to having.
A seeker does not want to reason about "3,200 km² of shading" — they want to reason about
"nine stations left". New `src/hiding-zones.js` (pure, DOM-free) is the bridge.

- **Item L — a station survives if ANY part of its zone survives, and this was a real bug.**
  `countStationsInEliminated` decided a station was ruled out when its exact coordinate fell
  inside the eliminated region. That is correct only if the hider is standing *precisely on*
  the station. They are hiding **within a radius** of it — so a station whose point was
  eliminated but whose surrounding ground was partly untouched got ruled out with the hider
  standing in the part that survived. **A false elimination: the failure mode that loses a
  game outright rather than costing a turn.**

  The zone rule replaces it: a station counts as eliminated only when its *whole* zone is.
  The test suite pins the exact geometry where the two rules disagree, and asserts that the
  old rule over-counts there (it claims 2 of 2 stations; the zone rule correctly claims 1).

  New `settings.hidingRadiusM` **defaults to 0**, which collapses the zone to the point and
  reproduces the previous behaviour *exactly*. That is deliberate: a non-zero default would
  silently change what every saved board says the moment it is reopened, possibly mid-game.
  Settings offers Off / 400 m / 800 m / 1.6 km.

  Undecidable stations (bad coordinates, geometry errors) resolve to **surviving**.
  Under-eliminating costs a turn; over-eliminating is the bug being removed.

- **Item M — four zone render styles** (`src/stations-layer.js`): circles, merged silhouette,
  points only, or nothing. The silhouette is not just a readability aid on a dense board, it
  is the more honest picture — separate overlapping circles imply more distinct places than
  actually exist. Zones draw below the markers and are non-clickable, so the existing
  long-press interaction is untouched. A failed union degrades to circles rather than
  blanking the overlay.

- **Item N — per-zone drill-down** (`zoneDiagnosis`, long-press ▸ "What survives here?").
  Reports how much of a station's zone survives *and which questions cut into it*. That
  second half is the valuable one and is not derivable from the map: a zone can be eliminated
  by the **combination** of two questions while neither does it alone. Naming them tells the
  seeker which answer to re-check when a station they were confident about vanishes. Drafts
  and disabled questions are correctly excluded; a zone that never overlapped the board
  reports `null`, not 0%.

- **Item O — custom station lists** (`src/station-import.js`, CSV / GeoJSON / KML).

  > ⚠️ **Correction.** As committed in this phase, item O shipped the **parser only**. Nothing
  > in the app imported it, so the feature was not reachable by a player — 22 passing tests
  > and no way to use it. The UI landed later, in *v2 audit* below. This entry originally read
  > as though the feature were complete; it is left in place with this note rather than
  > rewritten, because a changelog that quietly edits its own history is worth less than one
  > that records being wrong.

  The point is not the file formats: a group who have already agreed a station set (a shared Google
  MyMaps layer, a spreadsheet, a converted GTFS export) had to retype it or play with a
  different set from the one they agreed. KML is here because MyMaps exports it and MyMaps is
  what non-technical players use.

  Dependency-free and DOM-free by choice — a hand-rolled CSV reader (quoted fields, embedded
  commas, CRLF, BOM) beats a new dependency in a PWA that must work offline, and a regex KML
  scan is testable under `node --test` and works in a worker. Format is sniffed from
  **content**, not the hint, because the hint is routinely wrong.

  Two behaviours worth calling out: a re-import **never overwrites an existing station**, so
  eliminations the seeker has already made survive it; and an in-range lat/lng transposition
  is imported as given rather than guessed at, because 72.8 is a real latitude and rejecting
  it would break every Arctic board.

Suite: **810 → 854 tests, all passing.**

## v2 Phase 4 — Data resilience (§10.4 items P, Q, R, S, T)

Two real gaps closed and three items found already satisfied. Recording the "already fine"
ones matters as much as the changes — they are the parts a later pass would otherwise
"fix" twice.

- **Item R — in-flight de-duplication** (`src/net.js`, 5 tests). A board where several
  questions need the same rail geometry fired several identical multi-second Overpass
  queries, because each loader independently missed the cache. Against a volunteer service
  where ~64% of individual calls already fail, that is both slower for the player and rude to
  the upstream. `dedupe(key, fn)` collapses concurrent callers onto one request.

  The subtlety is what happens on failure: the entry is released when the promise **settles**,
  not when it resolves. Caching a rejected promise would let one transient Overpass failure
  poison that query for the rest of the session, showing a permanent error where a retry
  would have worked. Wired into the lines and stations loaders — station sets are the
  most-shared payload on a board, so that is where it earns most.

- **Item P — more than one proxy** (`src/net.js`, `config.example.js`, 9 tests).
  `OVERPASS_PROXY_URL` now accepts a comma-separated list or an array and tries each in
  order. A **4xx stops the walk** — a malformed query fails identically everywhere, so
  retrying it burns the budget and then reports "all proxies down" when the truth is "this
  query is wrong". That distinction already existed server-side in `overpass.js`; this keeps
  it client-side rather than flattening it. One configured base behaves exactly as before, so
  no existing deployment changes.

### Already satisfied — deliberately not re-done

- **Item P (server half)** — endpoint failover across public Overpass instances already
  exists in `overpass.js`, with a **measured** ordering (maps.mail.ru 83%, overpass-api.de
  28%, kumi 0% over 61 live attempts) and a multi-pass budget. Nothing was duplicated.
- **Item Q — cache segmentation** — already done: `lines` and `stations` are separate
  IndexedDB stores with their own keys, a 30-day TTL, payload pruning, and a **stale-cache
  fallback** when the network fails. That is what the reference achieves with three named
  Cache Storage buckets, and the stale fallback is better than what it does.
- **Item S — simplify board polygons in queries** — does not apply. The proxy takes a
  **bbox**, not a polygon, so there is no multi-kilobyte ring in the URL to simplify. This is
  a better shape than the reference's, which inlines every vertex of a hand-drawn board into
  every query it makes.
- **Item T — `brand:wikidata` for chains** — not applicable yet: there are no chain cards
  (McDonald's / 7-Eleven) in the question bank. It belongs with adding one, in Phase 5.

Suite: **854 → 868 tests, all passing.**

## v2 Phase 5 — New questions and accuracy (§10.5 items J, K, D, E)

- **Item J — "Station's Line"** (`src/tools.js`, `src/data/questions.js`, `src/layers.js`,
  `src/oracle.js`, `test/station-line.test.mjs`, 11 tests). *"Is your nearest station on the
  same line as mine?"* — one of the strongest questions in the real game, and one Google
  **cannot** answer: the Maps APIs expose no line membership at all. Answerable here only
  because the board already sources real rail geometry from OSM.

  Deliberately **not** a duplicate of the existing Transit Line card. That one asks which line
  you are physically *closest to*; this asks about *membership*. A hider can stand much nearer
  line B's track while their nearest station is on line A — a test pins exactly that case, so
  the distinction stays real rather than becoming a refactor casualty.

  This card only became possible because of Phase 3: the answer constrains the hider to "near
  one of these stations", and the elimination is the union of those stations' **hiding zones**.

  **It carries a precondition, and the code says so loudly.** The card is sound only while the
  hider really is within the hiding radius of a station — i.e. only in a game actually played
  by the hiding-zone rule. A hider 3 km from their nearest station can answer "same line"
  truthfully and still sit outside every zone the answer keeps. That is the card's premise,
  not a geometry bug, and the radius requirement is what enforces it. The test suite asserts
  the survival property over positions that satisfy the premise **and pins the out-of-premise
  case separately**, so the limit stays visible instead of becoming a mid-game surprise.

  With no radius set the card refuses outright rather than eliminating nothing.

- **Item K — ternary name-length answers** (`test/name-length-ternary.test.mjs`, 8 tests).
  "Same length?" throws away most of what the hider just told you: they know whether theirs is
  *shorter*, *the same*, or *longer*, and saying which costs them nothing. Measured on the test
  fixture, a directional answer eliminates **1.5× as much ground** as "different" — and on a
  real board the gap is larger, because exact name-length ties are rare, so the boolean
  question is usually answered "no" and cuts very little.

  Fully backwards compatible: steps saved in the old `{ match }` form keep meaning exactly what
  they meant, pinned by three tests. A saved game that changes its answer when the app updates
  mid-game would be worse than a missing feature.

  One case only the ternary form reaches: the seeker holds the shortest name, so *nothing* is
  shorter. That is a real and very strong answer — it rules out the whole board — and the
  dangerous thing would have been `eliminated: null`, which reads as "ruled nothing out".

- **Item E — bound the buffer error rather than trusting it**
  (`test/buffer-accuracy.test.mjs`, 5 tests). MAPPER_ANALYSIS §3.4.1 measured the reference
  mapper's coastline buffer over-including by up to **286% of the threshold**. We use the same
  `turf.buffer`, so the question was not "is it exact" (it is not) but "how wrong is it here,
  and in which direction".

  Measured against a brute-force geodesic distance field over ~2,100 sample points: **>97%
  agreement** on a deliberately crinkly reference at 500 m / 2 km / 6 km, and every
  disagreement confined to a narrow band around the threshold — proving the buffer is the
  right *shape*, not merely close. The tests pin both the magnitude and the direction, so a
  future turf upgrade that changes buffering shows up as a diff instead of a subtly different
  board.

  We are materially better than the reference here for a structural reason, now asserted: our
  references come from OSM at full resolution, where its coastline is Natural Earth 1:50m with
  a **7.65 km median vertex spacing** — coarser than the thresholds being measured on it.

- **Item D — coastline from OSM** — already done. `natural=coastline` via the Overpass proxy,
  exactly as recommended, and the reason our buffer accuracy beats the reference's.

Suite: **868 → 892 tests, all passing.**

## v2 Phase 6 — Sharing and UX (§10.6 items U, V, W, X, Y)

- **Item U — the whole game in a URL** (`src/share-link.js`, `src/games.js`, `src/app.js`,
  `test/share-link.test.mjs`, 18 tests). `deflate` → base64url in a query parameter. No
  accounts, no backend, no upload — for a game where players hand a phone around or coordinate
  over chat, this is the highest value-per-line thing the reference mapper has.

  **Deliberately not copied: its overflow path.** When its link exceeds ~2,000 characters the
  reference POSTs the game to Pastebin through `cors-anywhere.com` — the user's API key *and*
  their whole board through a third-party CORS proxy of unclear provenance (§7.7). An
  oversized board here is told to use the JSON export it already has. A share button must
  never be the reason data leaves the device by a route the player did not choose.

  Two design decisions in the payload:
  - **Notes are not shared.** They routinely carry private context, and a link goes to the
    other team as often as to a teammate. The JSON export still carries them — that is a
    deliberate, file-shaped action rather than a pasted link.
  - **The station list is dropped, its eliminations are kept.** The list is re-sourceable from
    the board and is what would blow the URL budget (400 stations still fit comfortably once
    it is dropped); the eliminations are hand-made deductions that cannot be re-derived.

  A share link is treated as **untrusted input**: truncated, edited, or future-version links
  refuse with a specific reason rather than half-loading. A board that loads with some
  questions silently missing is worse than one that refuses — the seeker cannot see what is
  absent. The parameter is cleared after load either way, so a refresh cannot pile up
  duplicates.

- **Item W — boards can have holes** (`src/geo.js`, `src/zones.js`, `styles/main.css`,
  `test/board-subtraction.test.mjs`, 10 tests). Zones were union-only, which cannot express a
  board with an excluded area — and those are ordinary, not exotic: the bay in the middle of a
  harbour city, the airfield nobody may enter, the borough the group agreed is out of play.
  Without it a seeker either draws an awkward ring of zones around the hole or reasons about a
  board they know is wrong.

  New "✂️ Exclude an area" draws a subtracting zone. The fold unions all additions first, then
  removes the union of the subtractions **once** — order-independent on purpose, because the
  order zones happened to be drawn in is invisible in the UI and a board that depended on it
  would be impossible to reason about. A subtraction that cannot be applied returns *no board*
  rather than silently falling back to the un-subtracted one, which would compute every
  elimination over ground the player deliberately excluded. Zones with no `mode` add, so no
  saved board changes meaning and no migration is needed.

### Already done, and one item declined

- **Item X — the guide in-app** — already shipped in v1 Phase 38 (`src/guide.js`), including a
  live permissions wizard on the native shell.
- **Item Y — export the board** — JSON export/import already exists. A print/PDF path was not
  added: this is a phone-first field app where the platform screenshot is both faster and what
  players already use.
- **Item V — auto-save toggle: considered and declined.** The reference's toggle exists because
  a single recompute there can cost seconds. That problem is already solved here by the four
  memo layers (`_elimCache`, `_activeMemo`, `_bufferCache`, `_clipCache`), which took a live
  Mumbai coastline board from ~6,948 ms per drag to a cache hit. Adding a mode that suspends
  saving would trade a solved performance problem for an unsolved data-loss one — in a field
  app, on a phone, whose battery dies mid-game. Copying it here would be a regression.

Suite: **892 → 920 tests, all passing.**

## v2 audit — one gap found and closed

After all six phases were pushed, every new module was checked for **reachability from the
running app**, and each phase was then re-verified functionally in a real browser rather than
only through its unit tests.

**Item O was orphaned.** `src/station-import.js` had 22 passing tests and nothing in the app
imported it — the parser existed, the feature did not. A player could not import a station
list. Now wired into Stations ▸ *Import list (CSV / GeoJSON / KML)*, by file or paste, with
merge (default) or replace. Merge is the default deliberately: it can only add, while replace
discards a set that may carry eliminations the seeker reasoned their way to, so the
destructive option is the one you have to choose. An import clears `confirmedAt`, because a
changed set has not been agreed yet.

This is worth recording as a process point, not just a fix: a green suite proved the parser
correct and said nothing about whether the feature was connected. Reachability is a separate
property and now has its own check.

`src/oracle.js` is also imported by no `src/` file, but that is **by design** — it is a test
fixture and a future post-game debrief tool, never a live answering path (§10.6).

### Per-phase functional audit (real app, stubbed Google Maps, headless Chromium)

All 16 checks pass:

| Phase | Verified in-app |
|---|---|
| 1 | oracle retains the hider; a failing question reports `"compute"` rather than passing silently |
| 2 | a draft leaves 263 km² where applying it would leave 13; derived distance correct to a line; degeneracy note fires at n=1,2 and is silent at n=5 |
| 3 | zone rule keeps a station the point rule drops; all four render styles produce geometry; drill-down names the culprit question; station import reachable and merging |
| 4 | 3 concurrent asks → 1 underlying call; 5xx walks both proxies, 4xx stops after one |
| 5 | Station's Line is in the bank, dispatches, eliminates via zones, and refuses without a radius; "shorter" eliminates 197 km² vs "different" 131 km² |
| 6 | share round trip preserves zones and drops notes (518-char link); subtraction cuts a real hole and excludes its centre |

Boot check: 16 modules wired, 0 unexpected console or page errors.

### Recorded test counts, verified against the commits

Because the audit found one claim in this changelog that did not hold, the numeric claims were
re-checked rather than trusted. Every phase commit was checked out into a worktree and its
suite run:

| Commit | Recorded | Actual | |
|---|---:|---:|---|
| `v1.0-stable` (pre-v2) | 756 | **756** | ✅ |
| Phase 1 `2fe1604` | 786 | **786** | ✅ |
| Phase 2 `75ef982` | 810 | **810** | ✅ |
| Phase 3 `f9fb176` | 854 | **854** | ✅ |
| Phase 4 `4ccd7fe` | 868 | **868** | ✅ |
| Phase 5 `23711ed` | 892 | **892** | ✅ |
| Phase 6 `2a07712` | 920 | **920** | ✅ |
| Audit `ffed11f` | 920 | **920** | ✅ |

Zero failures at every commit. So no phase was pushed with a failing suite, and the numbers in
this document are accurate. What was inaccurate was **narrative**, not arithmetic: the Phase 3
entry described item O as a delivered feature when only its parser had landed. That entry now
carries a correction in place rather than a rewrite.

### The orphan check is now permanent

`test/module-reachability.test.mjs` (4 tests) walks the real import graph from `src/app.js` —
following both static `import` and the dynamic `await import()` the sheets use — and fails if
any `src/` module is unreachable. `oracle.js` is allowlisted with a reason, and the allowlist
itself is checked (an entry must name a module that still exists and carry a real reason).

Verified to actually catch the bug it exists for: unwiring `station-import.js` makes it fail
with *"station-import.js is orphaned — CSV / GeoJSON / KML station import would not exist for
a player"*. A guard that passes vacuously would be worse than none.

## v2 completeness — §8.3's last two items, and a real playtest

Pressed on whether *the whole* of MAPPER_ANALYSIS was done, not just its §10 programme. It
was not: **§8.3 lists six data layers to source from OSM because Google cannot express them,
and only four had been done.**

- **§8.3 item 6 — peaks.** The Mountain card searched Google for the *keyword* `"mountain"`,
  with OSM only as a fallback. Google has no peak category, so that is a **name match** — it
  finds "Mountain View Hotel" as readily as a summit. `natural=peak` is exact.
- **§8.3 item 5 — brand-exact chains.** Missing entirely. *"Are you closer to a McDonald's
  than me?"* is a real Jet Lag question, and a Places name search picks up "McDonald's Farm
  Supply". `brand:wikidata` is a stable entity id, so it is immune to McDonald's / McDonalds /
  マクドナルド and to franchise naming.

Both are now sourced **OSM-first** via a new `OSM_EXACT_CATEGORIES` set, with Google as the
fallback — inverting the usual order. Deliberately separate from `DENSE_CATEGORIES`: that set
exists because Google's 60-result cap decides the answer (a **volume** problem), this one
because a name search answers a different question (a **correctness** problem). New McDonald's
and 7-Eleven Measuring cards; `mcdonalds` / `seven_eleven` added to the server tag map and the
client mirror. 7 tests, including one asserting the brand lookups never degrade to a `name=`
match.

This also retires the "N/A" verdict recorded against §10.4 item T in Phase 4 — there were no
chain cards *then*; there are now, and they use `brand:wikidata` exactly as recommended.

### Playtest — five full games through the running app

`test/playtest-games.mjs` (not part of `npm test`; needs a browser and a served copy). Each
game hides a player at a position the seeker logic never sees, plays a realistic question
sequence, has the hider answer **truthfully via the oracle**, and after every turn asserts
that the hider is still inside the surviving area, the board never grows, and surviving
stations never come back.

| Game | Turns | Board | Stations | Result |
|---|---:|---|---:|---|
| 1 — classic opening | 5 | 378.6 → 34.4 km² | 28 → 6 | ✅ |
| 2 — hider in the far corner | 4 | 378.6 → 33.6 km² | 28 → 2 | ✅ |
| 3 — draft two questions, then commit | 4 | 378.6 → 76.3 km² | 28 → 10 | ✅ |
| 4 — Station's Line decides it | 3 | 378.6 → 154.7 km² | 28 → 12 | ✅ |
| 5 — long game, eight questions | 8 | 378.6 → 5.3 km² | 28 → 2 | ✅ |

**24 turns, hider retained in every one.** Drafts provably changed nothing until committed
(game 3: 153.7 km² across two drafted turns, then 76.3 km² on commit). Plus a mid-game
**handoff** — board shared to a link, rebuilt on the "other device" to an identical 193.7 km²
with notes not leaked — and a mid-game **exclusion** cutting a bay out of play.

One honest note on method: the handoff check failed on its first run, and the fault was the
*test*, not the app — it hardcoded a `"hotter"` answer for a hider who was genuinely colder,
so the app correctly eliminated them. Fixed by having the handoff use the oracle like the
games do. Recorded because it is exactly the trap this whole build is about: a fabricated
answer produces a confident, wrong, plausible-looking result.

**This is still simulated play, not field play.** Real GPS drift, real Overpass latency and a
real phone remain untested; `v1-stable` is still the field-tested branch.

## v2 — sweeping up after the station list

Leftovers from the removed features, found by asking what still referenced them.

- **`src/guide.js`** still told players to *"Lock in the board's stations once (☰ menu ▸ 🚉
  Stations, from OSM or Google Places); line-, range- and name-length questions all refer to
  that set."* Every clause of that was false. It now describes the shortlist, and mentions
  that a share link carries it. This was the last user-facing description of the old workflow.
- **`Games` held `map` and `lines`** — the first for board-wide Places sourcing, the second
  for eliminate-by-line. Both features are gone and nothing else in the class touched either,
  so the constructor no longer takes them and `app.js` no longer passes them. The
  `places.js` import they justified goes too.
- **Dead CSS** for the eliminate-by-line block (`.station-line-list`, `.station-line-row`).
- **Stale comments** naming the "locked station set" and the retired A3/A4/A5 items.

**Rail is NOT obsolete and stays.** Worth stating, because the removed eliminate-by-line
lived behind it: the 🚄 panel draws rail lines from OSM, and `candidateLines` — which honours
the panel's per-line filter — is what both **Transit Line** and **Station's Line** ask for
their candidates. `lineGroups()` looked orphaned after eliminate-by-line went, but the panel's
own render and filter still call it.

**Hiding radius stays too, and is required.** It is the only input the Station's Line card has
for how much ground "near one of these stations" covers, and that card refuses rather than
guess when it is 0. It would only become removable alongside Station's Line itself.

Verified: 887/887 unit tests; a 12-check browser pass confirming the guide text changed, that
`Games` no longer carries what it does not use, that Rail is still wired, and that Settings
kept the radius and lost Zone display. All four browser suites re-run clean.

## v2 — the station list is now a hand-tapped shortlist

The end of the review. The locked, board-wide station set is gone; what is left is a
shortlist you build by tapping the map when a game has narrowed down.

**Removed:** whole-board sourcing from OSM and Google Places, the "Lock in this set"
confirmation gate, eliminate-every-station-on-a-line, range-along-a-line ("not past
Dahisar"), and the `source` / `bbox` / `confirmedAt` fields behind them.

**Kept, and now the whole workflow:** tap the map to add candidates, see them as markers,
long-press one to strike it off or drop a note. This is what the list was wanted for — six
candidates left, work through them one at a time — and it was previously the smallest button
in a sheet that opened by asking you to materialise several hundred stations.

**Station's Line was the blocker, and was rebuilt first** (previous entry): it sources and
confirms its own stations per question, so no question reads the list any more. That is what
made the set removable at all.

**A latent bug found on the way out.** Share links carried `stationEliminations` — the ids of
stations the seeker had ruled out — on the theory that the receiver would re-source the same
set and re-apply them. Nothing ever read the field back, so those deductions silently did not
travel, and with hand-placed `manual:` ids they never could have. The link now carries the
shortlist outright, which is affordable precisely because it is a shortlist: 25 stations sit
comfortably inside the URL budget where 400 sourced ones were the reason for the original
omission.

**Old saves open unchanged.** The retired keys are ignored rather than migrated, and there is
a test asserting a game saved in the old shape still opens with its stations and its
eliminations intact.

Suite 895 → 886: four test files existed only for sourcing, line elimination and range
elimination. `game-full-playtest.test.mjs` was rewritten rather than deleted — its games 1
and 2 now compose the geofence, ingest, notes and live-share phases with the tap-and-strike
workflow that replaced the removed steps.

Verified: 886/886 unit tests; `test/stations-panel-e2e.mjs` 19/19 in a browser, half of it
asserting the removed buttons are actually absent; the 5-game playtest still clean.

## v2 — the station list becomes a late-game instrument

A point-by-point review of everything the station list did, and most of it went. The list is
meant for working through the last handful of candidates one at a time — not a ~500-entry
domain assembled before the first question, and not a source of automated conclusions.

**Kept:** map markers, the long-press chooser, manual eliminate/restore, the Stations panel,
map-tap add, the line and range bulk actions, the Station's Line card.

**Removed, in three passes:**

1. **The per-station "What survives here?" drill-down.** Late in a game, with a short list,
   the map already shows what it was reporting.
2. **The "N of M active stations would be eliminated" readout** in the draft preview. This
   was the single thing pushing a seeker to build a station set on turn one — with no list it
   read as a missing setup step. The area figure stays; it needs no setup.
3. **The CSV / GeoJSON / KML import tool.** A bulk-load path presumes you arrived with a
   file, which is pre-game prep — the thing the list is being pulled away from. 243 lines and
   22 tests of hand-rolled parsing for the rarest action in the panel. Map-tap covers the
   sizes that matter.
4. **The hiding-zone overlay and the whole Zone display setting.** Removed as unfair
   automation: drawing "everywhere the hider could be" does the seeker's spatial reasoning
   for them. Circles / merged silhouette / points-only / no-display all go, and
   `src/hiding-zones.js` with them.

**The finding that made this cascade.** Removing (1) and (2) removed the last consumers of
the zone-survival rule — and it emerged that nothing in the app had *ever* eliminated a
station from geometry. Stations are only eliminated by hand (a tap, a line, a range), which
is a seeker's observation rather than a deduction. The rule existed solely to make those two
readouts honest, so `zoneSurvives`, `splitByZoneSurvival`, `countStationsEliminatedByZone`,
`zoneDiagnosis` and `countStationsInEliminated` all went dead at once. Dead safety code that
reads as if it were enforcing something is worse than none. Removing (4) then orphaned the
last two functions and the module went entirely.

**`hidingRadiusM` survives, reframed.** It is a RULE the group is playing ("how far from a
station may a hider be"), not a display setting, and nothing is drawn for it. Its one
remaining consumer is the Station's Line question, which needs it to know how much ground
"near one of these stations" covers and refuses outright rather than guess when it is 0. The
Settings section is renamed **Hiding radius** and its copy rewritten — the old text described
a station-elimination rule that no longer exists.

The playtest's never-resurrect invariant was preserved by moving the survival rule into the
test that needs it, rather than dropping the check with the code.

Suite 951 → 895. Full playtest re-run clean: 5 games, 24 turns, hider retained, handoff and
exclusion holding, 0 console errors. Settings sheet verified in a browser.

## v2 — no auto-answering, enforced rather than intended

The companion never answers its own questions. That has been the decision since Phase 5 built
auto-answer and the next phase removed it, and it was reaffirmed again here. What had not
happened is anyone making it *structurally true* — so this closes the gap between the policy
and the code.

Nothing in the shipped app was auto-answering. The problem was everything sitting one small
step away from it:

- **`src/oracle.js` → `test/oracle.js`.** The one piece of code in the repo that can answer a
  question without a human was living in the app's source tree, held back only by an entry in
  an allowlist saying "unreachable on purpose". That is a comment, not a boundary: it shipped
  to every device as a fetchable module, it is what a refactor reaches for first, and it reads
  as app code to anyone opening the folder. In `test/` it is out of the companion entirely.
  The hider-survival property it exists for (§10.1 item A) is untouched and still asserted on
  every commit.
- **The reachability allowlist is now empty.** Its only entry was ever the oracle. Every
  module under `src/` is expected to be reachable from the app, and an orphan is a bug again
  rather than a category with an exception in it.
- **GUIDE.md §6.1 rewritten.** It still specified the hider lock as a thing that lets "tools
  auto-answer their own questions", in the present tense, in the spec section — three years of
  removals had not touched the document that would tell the next person to build it. It now
  describes the hiding zone as what it is (a display aid) and records why the rest is gone.
- **IMPROVEMENTS.md Phase 11's "optional computed-truth verification" is REJECTED.** It had
  been sitting on the roadmap as an `[ADD]`, framed as the safe middle ground: let the human
  answer, compute the correct answer, warn on disagreement, never override. It is not a middle
  ground. A check that computes the answer has already decided what the truth is, and the only
  remaining question is how loudly it says so — and a player on a street, holding a phone that
  sounds certain, defers. Same failure mode as full auto-answer, wearing a conservative
  design. MAPPER_ANALYSIS §10.6's "ship it as a post-game debrief tool" is rejected for the
  same reason, annotated in place: a debrief tool is the same code making the same claim to
  know the truth, separated from live answering only by when someone opens it.

**`test/no-auto-answer.test.mjs`** is what makes it stick, checking four things that fail
independently: no module under `src/` imports the oracle; the oracle is not in `src/` at all;
nothing under `src/` defines its own answer-deriving function (name-based — a tripwire for
`truthfulAnswer`, `autoAnswer`, `deriveAnswer`, `computedTruth`, the reference mapper's
`hiderify*` — and it ignores comments, so explaining the absence is not punished); and the
service worker does not precache it. There is deliberately **no allowlist**; an exception
would defeat the point.

Each guard was verified by reintroducing the exact violation it targets and confirming the
expected failure, then reverting: an app module importing the oracle, an app module defining
`deriveAnswer`, and the oracle restored to `src/`.

**One thing deliberately kept**, flagged because it is the closest call: the Measuring sheet's
"📍 Measure from my location", which fills in **the seeker's own distance** to a reference from
their own GPS. It computes nothing about the hider — the hider's answer is still the
closer/farther choice a human enters — and it replaces a hand-typed number that is a pure
error surface. Say the word and it goes.

Suite 947 → 951, and the full playtest (5 games, 24 turns, handoff, exclusion) re-run clean
with the oracle in its new home.

## v2 — build identity: telling which commit a phone is actually running

Prompted by a real incident: the wrong APK was installed on the test phone and showed a
"No connection" screen, and there was no way to tell from the device which build it was.
That turned out to be a wrong-APK problem, but it exposed a gap that survives fixing it —
even with the right APK, the shell is a TWA that carries **no app code and no commit id**.
It opens a URL. Whatever that URL served is the build, and it can be older than the deploy
without any visible sign.

So the question "am I on the right version" was made answerable from the device itself.

- **`version.json`**, written by `scripts/build-config.js` beside `config.js` from Render's
  `RENDER_GIT_COMMIT`. It must be a separate file from `config.js`, and that is the whole
  mechanism: `config.js` is frozen at page load, so its `BUILD_ID` describes *the build the
  page is made of*, while `version.json` re-fetched now describes *the build the origin has*.
  One file could only ever report one of those, and comparing a value against itself always
  says "fine".
- **`src/version-check.js`** does the comparison. Caches are defeated three ways, because
  they fail in different places: `no-store`, a timestamp query for caches that ignore it, and
  a service-worker bypass (`render.yaml` adds the CDN header). A cached answer to "is my cache
  stale" would be produced by the very cache under suspicion.
- **A banner naming both commits** — `Running abc1234 — server has 9f8e7d6` — not "an update
  is available". The point is to identify the build, and a generic message discards the only
  information the check has. `Reload` calls `reg.update()` and activates a waiting worker
  before reloading, so the reload has somewhere fresh to land.
- **`version.html`**, a standalone diagnostic that imports *nothing*: no modules, no `src/`,
  no Maps, no IndexedDB. It exists for when the app is too broken to ask, which is exactly
  when the question is most urgent. It shows loaded vs served vs **backend** commit (the
  backend is a separate Render service and drifts independently — `/health` now reports its
  own commit and `startedAt`, which distinguishes a redeploy from a free-tier wake-up),
  service-worker and cache state, and offers a clear-caches-and-reload. It duplicates one
  string comparison from `version-check.js` on purpose; sharing the module would couple the
  diagnostic to the thing being diagnosed.

The design constraint throughout was that this must never make things worse. It runs 1.5s
after `load`, off the critical path, and every failure — offline, 404 from a host deployed
before this change, captive portal returning HTML, a request that never answers — resolves to
"unknown" and shows nothing. A version check that can break the app is worse than no version
check, and this one runs on devices whose network is the thing in doubt.

16 unit tests for the comparison and every failure shape. `test/buildcheck-e2e.mjs` (20
checks, real Chromium, not in `npm test`) drives the actual page: match shows no banner,
mismatch names both commits and dismisses cleanly, a missing `version.json` still boots the
app with no errors, and — the one that matters — `version.html` still returns a verdict with
`src/app.js` forced to a 500. Suite 931 → 947.

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
