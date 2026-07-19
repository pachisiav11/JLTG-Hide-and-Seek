# Three autonomous cycles — consolidated summary

**2026-07-19.** Repo `D:\Projects\JLTG`, branch `main`, started clean at `9d17661` with 307
tests passing. Finished at `9220fc1` with **378 tests passing**, 11 commits, every one pushed.

Read this section and stop, if you only read one:

> Nothing in the original review list turned out to be the biggest problem. The largest defect
> found — a coastline question costing **6,948 ms per drag event** — was found by *playing* the
> game, not by reading it, and only after the two review documents had been worked through. The
> second and third largest were correctness bugs that would have silently given a player the
> wrong answer. And one of the six findings I was asked to fix, **P3, was wrong** — its cost was
> real but its failure scenario did not exist, so it is recorded as cleared rather than fixed.

---

## What changed, in order

| commit | what | headline number |
|---|---|---|
| `9f65438` | **P1** trace sheet stopped blocking on 25 Overpass probes; **P2** `candidateLines` stopped measuring distances Matching discards | 34,067 ms → 1,000 ms · 606.5 ms → 29.7 ms |
| `fd6d480` | **P3** cleared against measurement; **P4** refused line card now hands the player the rail filter | refusal path 606.5 ms → 16–36 ms |
| `363e515` | **P5** map claims counted, not flagged; **P6** `store.update` skips save+emit when nothing changed | latent bug removed · 0 writes, 0 emits |
| `046b82c` | **C1-3** a thrown zone union no longer leaves the rejected zone on the board | corrupt board prevented |
| `c35974e` | **C1-5** a failed union mid-fold no longer discards everything folded so far | wrong elimination prevented |
| `623795e` | **C1-7** an unreadable answer no longer produces a confident wrong elimination | 369.5 km² eliminated from *no answer* → 0 |
| `252917d` | **C1-4** reference buffer memoised | 6,948 ms → 334 ms per drag |
| `c3b27ee` | **C1-6** client proxy fetches given a timeout | ∞ → 60,017 ms, then stale-cache fallback |
| `56106e3` | **C2-1** buffer clip memoised too | 340 ms → 112 ms per drag |
| `96b3812` | cycle-2 record: **C2-2** cleared, two clean review sweeps | — |
| `9220fc1` | **C3-1** `computeActiveArea` stops refolding unchanged eliminations | 148.7 ms → 72.4 ms |

20 files changed, 1,802 insertions. Tests 307 → 378 (+71), all passing.

---

## The things that actually mattered

### 1. A coastline question froze the app for seven seconds per interaction

Not in either review document. Found in cycle 1's game tests by using the tool on a real board.

Mumbai's sourced coastline is a 98-part MultiLineString of 5,320 vertices. Buffering it cost
~3.9 s, nothing cached it, and `computeActiveArea` runs on every `emit`, which runs on every
`store.update`. So **every drag event, question toggle and marker move on a board carrying one
coastline question cost about seven seconds.**

Fixed across three commits by memoising, in order, the buffer, the clip, and the fold —
measuring between each to decide whether the next was warranted:

```
one store.update, coastline board
  before          6,948 ms
  buffer memo       334 ms
  clip memo         112 ms
  active-area memo  ~112 ms   (the remaining cost is render, not geometry)
                              62x overall, answer identical at every stage
```

The answer was re-checked at every step and never moved: 631.8 km², then 31.9 km², before and
after each memo.

### 2. Three ways to silently give a player a wrong answer

All three would have shaded the map wrongly with nothing on screen saying so — the failure mode
this codebase cares most about.

- **C1-7** — `side === "hotter" ? A : B` treated *any* unrecognised answer as a vote for B. A
  thermometer step with no answer at all eliminated 369.5 km² of a 628.6 km² board, and
  `describeStep` then labelled it "colder (→A)" so the questions panel **agreed with** the wrong
  elimination. Radar and measuring shared the shape. Now one `readSide` helper: an unreadable
  answer eliminates nothing and is labelled "unanswered".
- **C1-5** — `union = union ? safeUnion(union, c) : c` nulls its accumulator when a union fails
  and restarts from the next member, discarding everything folded so far. This is a *known* bug
  shape here (`lineCells` was already fixed for it, the A7 note) that had survived in two more
  places. Now a shared `unionAll` that keeps the last good accumulator.
- **C1-3** — `addZone` pushes a zone, folds, and pops if the fold failed. `Zones._fold` handled a
  union that *returned* null but not one that **threw**, so the exception escaped the mutator and
  the `pop()` never ran: the refused zone stayed on the board. Reproduced live, 1 zone → 2.

Each is reachable through **import**: `validateGame` checks that a step names a known tool and
that a zone has a `polygon` array, but never that the answer is readable or the ring well-shaped.
That is the common thread, and it is worth a future pass of its own.

### 3. A hung fetch had nothing to end it

`overpass.js` passes `AbortSignal.timeout` with the reason written beside it. Neither client-side
proxy call did. Observed live in cycle 2, not merely read: a `/overpass/lines?kind=coastline`
request sat pending with no status and nothing to stop it. Now 60 s, after which the existing
cache ladder serves the stored copy.

---

## What I cleared rather than fixed

Recorded because a review that only lists hits hides how much of it was guesswork.

- **P3 — the premise was false.** P3 said a full game record is rewritten on every drag event.
  `scheduleSave` is a *trailing* debounce that clears its timer on every call, so a 60-event drag
  performs **zero** IndexedDB writes; one write lands 500 ms after the drag stops, costing 18.4 ms
  on a 240.8 KB board. The size half of P3 is real (5 sourced rail lines are 101.7 KB against
  0.155 KB for two drawn ones) but no fix was warranted. **This is the item I was asked to fix
  and did not** — see "decisions I made on your behalf".
- **P4's suggested default** — hiding `route=train` on a new board. Measured across four boards
  it lands on both sides of the limit: repo fixture 4, city board 8, MMR 9, game-6 board 9,
  against a limit of 8. A default whose correctness depends on when the board was captured is not
  a fix, and it decides for the players the one thing the rail filter exists to let them decide.
- **C2-2 — transient overlays surviving a game switch.** Reported by a review; does not
  reproduce. `app.js:195` has one store subscriber that clears boundaries, features and lines on
  any game-id change, covering all four switch flows centrally. A guard implemented centrally
  looks exactly like a missing guard from inside the files it protects.
- **Every `addStep` shape matches what `computeElimination` reads** — cross-checked call site by
  call site. No mismatches. Worth having checked: my own test harness made that error twice, and
  chasing the second one is what surfaced C1-7.
- **C1-1, the per-drag re-render** — filed in cycle 1 at 3.55 ms/event and deliberately not
  fixed: it drops no frame on any device measured. The memo work reduced its context anyway.

---

## Decisions I made on your behalf

1. **P3: cleared, not fixed.** You asked for a judgement between three fixes and said to prefer a
   separate step-geometry store or harder debouncing over `turf.simplify`. Measurement said none
   was warranted — the debounce already coalesces a whole drag into one write, so there is
   nothing left to coalesce, and a separate store would buy migration, export/import referential
   integrity and undo/redo complexity to remove an 18 ms write that happens once per interaction
   pause. `turf.simplify` was rejected outright as you indicated. **If you disagree, this is the
   one to revisit** — it is the only place I declined work you explicitly scoped.
2. **P4 solved as an interaction, not a default.** The refusal now offers to open the rail panel
   (a confirm, then `lines.openPanel()`), instead of the suggested `hiddenRoutes` default, for
   the measured reason above.
3. **Memoised in three steps, not one.** I could have memoised whole eliminations at the start.
   Measuring first showed the buffer alone was 92.9% of the cost, so each stage was justified by
   its own number and the riskiest change (keying on whole step inputs, which mutate in place
   during a radar drag) was never needed.
4. **60 s client timeout** is a product decision, not a mirror of the server's ~9.5-minute worst
   case. A round has a clock, and a stale copy beats a spinner that resolves in nine minutes.
5. **`readSide` refuses rather than guesses.** An unreadable answer could have been given a
   backward-compatible default. I chose to eliminate nothing and say "unanswered", because both
   possible legacy readings are guesses and one of them shades the map wrongly.
6. **Cycle 3's review budget went to attacking the new caches** rather than sweeping new files,
   since they are the newest code and a stale active area is the worst bug available here.

---

## Added after the cycles closed

Two commits, on a direct follow-up question about what was left:

- **`2db9835` — C3-4.** The import-validation gap named below as the highest-value follow-up is
  now closed: a malformed ring is refused at the door rather than loading and breaking the board
  later. Unreadable *answers* are still accepted on purpose, because since C1-7 they degrade
  gracefully and discarding a whole game over one bad answer is the worse trade.
- **`d21eeee` — C3-5, a regression I introduced in C3-1 and did not catch there.** The
  `computeActiveArea` memo skipped `onFail` on a hit; I had reasoned the caller was already
  informed. It is not — `layers.js:225` resets `failedSteps` every render and depends on `onFail`
  to refill it, so a question that could not be folded into the mask lost its warning on every
  render after the first, while still being missing from the mask. Failures are now recorded and
  replayed. **Found by checking whether the last deferred item was safe, not by a test** — which
  is the honest lesson: 379 passing tests did not catch it.

Tests 379 → 391. That second one also settles the open question below.

## What I did not do

- **`emit` is still synchronous per `store.update`, and I now recommend leaving it that way.**
  Coalescing it to one call per animation frame is the last lever on drag cost. When I went to
  check whether it was safe, the very first thing I found was C3-5: a far smaller change to the
  same path had already introduced a silent regression that 379 tests did not catch, because
  render timing is load-bearing in non-obvious ways (`failedSteps` is rebuilt from `onFail` on
  every render). Against a cost that no longer stalls — 112 ms on a 3-question board, 260 ms on
  a 5-question one including a coastline — that is a bad trade. **Say the word and I will do it,
  but I would want a frame-timing harness first, not just the existing suite.**
- **Ring shape is now validated on import (C3-4); answer shape deliberately is not.** See above.
- **The union of per-step eliminations is not memoised** (133.7 ms on a 3-question board).
  Diminishing returns against another change to the same hot path.
- **Cold cost is untouched, deliberately.** A fresh board still pays ~7.4 s for its first
  coastline buffer and ~19 s for a cold division sweep. The memos remove repeat work only;
  nothing was made to look faster than it is.

---

## Numbers, collected

Every figure below was executed in the running app on a live Mumbai board against the local
Overpass proxy, or in the test suite where stated.

| what | before | after |
|---|---|---|
| admin trace sheet, cold board | 34,067 ms | **1,000 ms** (note injected at 33 s) |
| `candidateLines`, whole board | 606.5 ms | **29.7 ms** |
| Matching refusal path | 606.5 ms | **16–36 ms** |
| coastline elimination, warm | 3,954 ms | **1.1 ms** |
| one drag event, coastline board | 6,948 ms | **112 ms** |
| `computeActiveArea`, 3 questions | 148.7 ms | **72.4 ms** |
| hung proxy fetch | never returns | **60,017 ms**, then stale cache |
| refused zone | left on the board | rejected, board intact |
| thermometer with no answer | eliminates 369.5 km² | **0 km²**, labelled "unanswered" |
| 60-event drag, IndexedDB writes | 0 (already) | 0 |

Geometry correctness, checked every game test and never wrong:

```
radar 5 km IN        78.4 km2   vs pi*r^2 = 78.54    0.2% off
radar IN + OUT       78.4 + 1,167.1 = 1,245.5        the board exactly
coastline in + out   631.8 + 613.7 = 1,245.5         the board exactly
thermometer h + c    259.2 + 369.5 = 628.7           the board (628.6)
tentacles "none"     50.18 km2  vs 4*pi*r^2 = 50.27  0.2% (72-step circles)
zones union          628.6 < 687.1 sum               overlap counted once
undo -> redo         18.5 -> 39.6 -> 18.5            exact
export -> import     441.3 KB, fresh id, same area   round-trips
border level 2       null                            no border crosses Mumbai — a real answer
```

---

## Method notes worth keeping

- **Every fix was run against the pre-fix source** to confirm its tests fail there rather than
  passing vacuously. P1: 4 of 5 fail. P2: both behavioural tests fail. C1-3: 4 of 6. C1-6: 3 of 6.
- **Two cache tests initially passed for the wrong reason**, and in both cases the false pass
  looked exactly like a stale-cache bug: nested geometry produces equal answers for real reasons
  (a 66.36 km² buffer fits inside any board ≥ 0.2°; a 5 km inside-circle sits within a 9 km one).
  **When a cache test compares two configurations, prove they differ without the cache first.**
- **My own test harness produced two false alarms** by passing shapes the app does not use
  (`{warmer}` where `{side}` is read; a `lineGeometry` wrapper where `.geometry` is read). Both
  were my error — but chasing the second one is exactly what uncovered C1-7, which was real.
- **The memos were attacked deliberately, not assumed safe.** Cycle 3 spent its whole review
  budget trying to make them return a stale answer — mutation of `refGeometry` or `gameArea`,
  geometry reused across boards, two step lists colliding on identity. None broke. The one real
  catch was a *comment* in `bufferGeometry` asserting a guard that was not there ("passing a
  fresh feature is safest" — `feat()` only wraps, it does not copy). Harmless before, load-bearing
  once the memos key on identity, so it was settled by measurement: on a 1,124-vertex probe
  (above the simplify threshold, so it really ran) the stored geometry came back **byte-identical**.
  `turf.simplify` defaults to `mutate: false`. The invariant is now a test, not prose.
- **The first version of that probe proved nothing** — the repo fixture is 281 vertices, below
  the 500 threshold, so `simplify` never executed. Worth remembering: a test of a threshold-gated
  path has to clear the threshold.

---

## Postscript — games 7 and 8, after these cycles closed

Two further game tests were run on request. They found one high-severity defect, and it is the
most instructive one in the whole set: see [CYCLE4_FINDINGS_2026-07-19.md](CYCLE4_FINDINGS_2026-07-19.md).

**The C3-1 fold memo could not hit on nearly any real board.** It compares eliminations by object
identity, and only `measuring` produced stable geometry. Radar, thermometer, matching and
tentacles rebuilt theirs on every call, so a single radar anywhere on the board defeated the
entire fold. Fixed by memoising every tool's elimination (`_elimCache`): a repeat render on an
8-question board went 77.2 ms → 0.1 ms, and a focus-zone drag 86.3 → 31.2 ms per frame, of which
the active area is now 0.

**Why three cycles missed it.** Games 1–6 were all built around sourced geometry — coastlines,
admin divisions, rail — because that is where the expensive work lives. Those are also, purely by
accident, the only boards where the memo worked. Every measurement of it was taken on the one
configuration where it was fine. The lesson is not "measure more", which these cycles already did;
it is that **choosing the hardest case to measure can systematically hide a defect in the easy
one**, and the cheap case deserved a board of its own from the start.

**And it cost two tests.** Fixing it broke two union-failure tests that had been passing only
because the memo was dead — they shared one board across the file, so with a working cache the
second call was served the earlier healthy answer and never entered the fold. For one commit those
two tests would have passed whether or not the code under them worked.

The emit-coalescing item is still deliberately not done, and the new measurement supports leaving
it: the 24.7 ms that remains in a drag frame is `store.update` plus the app render, real but
modest, on the same path where C3-5 broke silently. The recommendation stands unchanged — say the
word and I will do it, but I would want a frame-timing harness first, not just the existing suite.
