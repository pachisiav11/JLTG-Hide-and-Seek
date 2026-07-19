# Cycle 4 findings — 2026-07-19

Two more game tests (7 and 8), run after the three cycles closed. Games 1–6 were built around
sourced geometry — coastlines, admin divisions, rail — because that is where the expensive work
lives. Games 7 and 8 deliberately went the other way: a board made almost entirely of *cheap*
questions, which turned out to be the case the three cycles' optimisation work never actually
covered.

| | finding | cost | where | severity | status |
|---|---|---|---|---|---|
| **C4-1** | The C3-1 fold memo was dead on any board holding a radar | 86.3 ms → 0 ms per frame | `tools.js:computeActiveArea` | high | **fixed** |
| **C4-2** | Two union-failure tests passed only because that memo was dead | false confidence | `test/union-failure.test.mjs` | medium | **fixed** |

---

## C4-1. The fold memo could not hit on nearly any real board

C3-1 memoised the fold. C1-4 and C2-1 memoised the buffer and the clip. What none of them did was
memoise the *elimination* for the tools that do not go through a buffer — and the fold memo
compares eliminations **by object identity**:

```js
_activeMemo.geoms.every((g, i) => g === elims[i].geom)
```

Only `measuring` fed it stable geometry, via `_bufferCache`/`_clipCache`. `radar`, `thermometer`,
`matching` and `tentacles` rebuilt their elimination from scratch on every call, so they handed
`computeActiveArea` a brand-new object every render and the check above could never match. One
radar anywhere on the board was enough to defeat the entire fold.

Games 1–6 all leaned on sourced geometry, so the memo was hitting whenever it was measured. That
is why three cycles of review did not catch it: the boards chosen to be *expensive* were also,
accidentally, the only boards where the optimisation worked.

**Measured on the live game-7 board** (8 questions, all radar and thermometer, 2,921.5 km² board):

```
repeat render, questions and board unchanged     77.2 ms   (should have been ~0)
same, all steps `measuring` instead               0.2 ms   <- the memo working
same, with ONE radar added                       24.2 ms   <- one radar kills it
```

And on the interaction that actually pays it — dragging the focus zone, which changes neither the
questions nor the game area, so every frame is a render the memo exists to make free:

```
focus-zone drag, before   86.3 ms per frame (worst 110.6)
focus-zone drag, after    31.2 ms per frame
  of which active-area recompute   0.0 ms
  of which store update + render  24.7 ms   <- unrelated; see the emit note below
```

**The fix** is a per-step elimination memo, `_elimCache`: a `WeakMap` on the step object holding
`{ gameArea, sig, eliminated }`. Scalars in `inputs`/`answer` are compared **by value**, because a
step keeps its identity while its contents are rewritten. Bulk payloads — sourced geometry,
feature and line lists — are compared **by identity**, the same invariant `_bufferCache` has
rested on since C1-4 and that C3-3 settled: they are stored rather than referenced and never
mutated in place. Serialising a 5,000-vertex coastline every render would cost more than the fold
it saves.

`computeElimination` is left uncached, so `layers.js:271` keeps getting fresh, freely-mutable
guide objects; only the mask path is memoised.

Verified live, against a ground truth computed on deep-cloned steps so no cache could serve it:

```
active area, before and after the fix    67.3 km2   unchanged
radar dragged 0.20 deg  (through memo)    0.37 km2  = uncached ground truth
radar returned home     (through memo)   67.34 km2  restored exactly
toggle / undo x3 / redo x3 / reorder / full elimination / recover
                                         all restored exactly
```

**A caution this cost.** A first drag probe moved the radar 0.05° and the area did not change,
which looked exactly like a stale cache. Re-run on deep-cloned steps it was 67.34 km² both ways —
the surviving 67 km² sits well inside a 20 km circle either side of a 5.5 km shift. A real
equality, not a stale hit. This is C3-2 for the third time, and it is now the standing rule for
this codebase: **when a cache test compares two configurations, prove they differ without the
cache first.**

## C4-2. Two tests were passing on cache state, not on behaviour

Fixing C4-1 broke two tests in `union-failure.test.mjs` — and they were right to break.

Both stub `turf.union` to make a fold fail, then assert the failure is reported. But they shared
one module-level board and one pair of step objects across every test in the file. With the memo
working, the second call in a test is served the earlier **healthy** result and never enters the
fold at all, so nothing fails and nothing is reported.

A stubbed global is invisible to a cache: the questions did not change, the board did not change,
so a hit is *correct*. The test's technique and a working cache are simply incompatible.

Fixed by giving each test a fresh board and fresh steps (a new `gameArea` is sufficient on its
own — the fold memo compares it by identity). The tests now exercise the fold they name. Left
deliberately as-is: the tests still stub the global rather than injecting a union function,
because that is the only way to provoke the real `safeUnion` failure path from outside.

Worth stating plainly: for one commit these two tests would have passed whether or not the code
under them worked, and only an unrelated optimisation exposed it.

---

## The two game tests

### Game 7 — a deep board of cheap questions (2,921.5 km², 8 questions)

Built to be the opposite of games 1–6: no sourced geometry at all, so every cost is fold cost.

| step | active left | ms |
|---|---|---|
| board, no questions | 2,921.3 | — |
| 1 radar 20 km IN | 1,255.0 | 39.2 |
| 2 thermometer hotter | 548.8 | 62.9 |
| 3 radar 14 km IN | 252.5 | 72.1 |
| 4 radar 3 km OUT | 227.4 | 106.3 |
| 5 thermometer colder | 148.4 | 95.5 |
| 6 radar 2 km OUT | 148.4 | 132.1 |
| 7 radar 10 km IN | 67.3 | 136.8 |
| 8 radar 1.5 km OUT | 67.3 | 147.5 |

Strictly monotonic, as a set difference must be. Steps 6 and 8 removed nothing — both circles fall
outside the area still alive by then, which is correct, not a failure. The per-step cost climbing
to 147.5 ms while the *board* shrinks is the C4-1 signature: the work scales with the question
count, not with the geometry.

### Game 8 — adversarial, on that same board

| check | result |
|---|---|
| toggle a middle question off / on | 67.3 → 86.3 → **67.3** exact |
| undo ×3 → redo ×3 | 67.3 → 148.4 → **67.3** exact |
| reverse the whole question list | **67.3** — order-independent, as a set difference requires |
| add a duplicate of an existing question | **67.3** — idempotent |
| radar dragged 0.20° and returned | 67.34 → 0.37 → **67.34** exact |
| eliminate the whole board (300 km OUT radar) | `EMPTY_AREA`, not null |
| remove that question | **67.3** recovered |
| export → import | 3.8 KB, fresh id, same zones, same questions, same area |
| rail sourcing, unbounded | 44 lines, all distances null, alphanumeric order |
| rail label ordering | Line 1 (1), Line 1 (N1), Line 2, Line 2B — the numeric sort from P2 |
| rail filter, hiding `train` | 44 → **9** visible, 35 hidden |

**A fourth data point for C1-2.** This board sources 44 rail lines and hiding `train` leaves
**9** — over the limit of 8. Four boards now: fixture 4, city 8, MMR 9, game-7 9. The review's
suggested default of hiding `train` on a new board would still have been right on exactly one of
them.

---

## Checked and cleared

- **The memo does not change answers.** Every game-8 check above was re-run after the fix and
  matched the pre-fix value exactly, including the two that must miss.
- **Nothing mutates a step's bulk inputs in place**, so identity is a sound key for them.
  `layers.js` builds `inputs` fresh in `addStep` and never writes into an existing step's
  `features`/`lines`/`refGeometry`; the guide anchors are `_lockedAnchor`, not draggable.
- **`computeElimination` is still uncached**, so guide rendering is unaffected by any of this.
- **The remaining 24.7 ms per drag frame is not the active area** — it is `store.update` plus the
  app render, i.e. the emit-coalescing item deferred at the end of cycle 3. The recommendation
  there is unchanged and this measurement supports it: the cost is real but modest, and C3-5
  showed how easily that path breaks silently. A frame-timing harness first.

## Non-defects, recorded so they are not re-investigated

- `store.newGame` takes an **overrides object**, not a name string.
- `store.importGame` saves the imported game and returns it; it deliberately does **not** switch
  the current game. The UI opens it separately.
- The rail filter lives at `game.railFilter.hiddenRoutes`, not `game.settings.railFilter`.
- Sourcing failed against the configured `OVERPASS_PROXY_URL` (the Render backend) and worked
  immediately against the local proxy on port 3000. Environment, not code — and already recorded.
