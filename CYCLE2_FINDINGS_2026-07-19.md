# Cycle 2 findings — 2026-07-19

Cycle 2 opened by finishing the work cycle 1 measured but deliberately did not fix (C1-4, C1-6),
then ran a fresh review and two more live game tests. Cycle 1's document keeps its own status
column; only findings that document did not already name are recorded here.

| | finding | cost | where | severity | status |
|---|---|---|---|---|---|
| **C2-1** | The buffer CLIP was recomputed on every render | 136.9 ms/render | `tools.js:measuring` | high | **fixed** `56106e3` |
| **C2-2** | Transient overlays claimed to survive a game switch | — | `games.js` | — | **cleared** — not reproducible |

Carried in from cycle 1 and closed here: **C1-4** (`252917d`) and **C1-6** (`c3b27ee`).

---

## C2-1. Memoising the buffer left the clip as the remaining cost

Direct follow-on from C1-4. With the buffer served from cache, the coastline step was still
almost the whole of a render:

```
computeActiveArea    148.7 ms
  radar                7.4 ms
  measuring          136.9 ms   <- clipping a 98-part buffer against the board
  thermometer          2.2 ms
```

Keyed on (buffer, gameArea, side) by identity. That is sound for the same reason the buffer memo
was: `gameArea` is **replaced, never mutated** — `Zones._fold` builds a new union object whenever
the zones change — so a new board is a new key rather than a stale hit. Nested WeakMaps keep
neither a discarded buffer nor a superseded board alive.

```
measuring step     136.9 ms -> 1.1 ms
one store.update     340 ms -> 112 ms
active area         31.9 km2 -> 31.9 km2   unchanged
```

**A test that nearly passed for the wrong reason**, recorded because it is the more useful half
of this finding. The first "a different game area is a different entry" test compared 0.2° and
0.6° boards and got identical answers — indistinguishable from a stale cache hit. It was not:

```
board size   0.05    0.1     0.2     0.4     1.0
clipped km2  2.26   27.41   66.36   66.36   66.36
```

This buffer is 66.36 km² and fits entirely inside any board of 0.2° or more, so both boards clip
to the whole buffer for a real reason. The test now uses 0.1° vs 0.4°, where the board genuinely
truncates the buffer, so it can actually tell a stale hit from a correct equal answer.

## C2-2. Transient overlays surviving a game switch — cleared

The UI review reported that `features.clearAll()` is called by `clearBoard` but by none of the
four game-switch flows (`openGame`, `newGame`, `duplicate`, import), so a directions route or
measure pins from board A would remain drawn over board B.

**Measured, and it does not reproduce.** Two measure pins placed on one board, then a game
switch:

```
before   pins 2, markers 2, line yes, active true
after    pins 0, markers 0, line no,  active false,  markers still on map: 0
```

The reason is `app.js:195`, which the review could not see because its scope was `games.js` and
`features.js`. A single store subscriber watches the game id and, on any change, calls
`boundaries.clear()`, `features.clearAll()` and `lines.clear()` — covering all four flows at once
rather than at each call site, deliberately (the comment there explains it fires on an id change
and never on a normal question update).

Recorded rather than dropped so a later pass does not re-derive it, and as a caution about
scoped reviews: a guard implemented centrally looks exactly like a missing guard from inside the
files it protects.

---

## The two game tests

Both on the live MMR Mumbai board (1,245.5 km²) against the local proxy.

### Game 3 — a stacked board, after the buffer memo

| step | active left | check |
|---|---|---|
| board | 1,245.5 | |
| + radar 8 km IN | 200.8 | |
| + coastline within 3 km | 129.5 | |
| + thermometer hotter | 31.9 | |
| drag event | — | **340 ms** median (was 6,948 ms for one coastline question) |

Every question strictly reduced the active area — monotonic, as a set difference must be.

### Game 4 — the same board, after the clip memo

| measurement | before | after |
|---|---|---|
| radar elimination | 7.4 ms | 9.3 ms |
| coastline elimination | 136.9 ms | **1.1 ms** |
| thermometer elimination | 2.2 ms | 1.6 ms |
| one `store.update` | 340 ms | **112 ms** |
| active area | 31.9 km² | **31.9 km²** |

Cumulative across cycles 1 and 2, a drag event on a coastline board went **6,948 ms → 112 ms
(62×)** with the answer unchanged at every step.

What remains inside `computeActiveArea` (133.7 ms) is the union of the per-step eliminations,
which is not memoised. Left alone deliberately: it is diminishing returns against a change to
the same hot path, and 112 ms per drag event no longer reads as a stall.

---

## Checked and cleared this cycle

- **C2-2**, above — the central subscriber in `app.js` already does what the review asked for.
- **C1-6 reproduced in the wild rather than only read.** While measuring C1-4, a real
  `/overpass/lines?kind=coastline` request for a Mumbai city bbox sat pending with no status and
  nothing to end it. Verified after the fix against a server that accepts and never answers:
  aborted with `TimeoutError` at **60,017 ms**, where previously the call never returned.
- **The memo does not change answers.** Checked at every step of both game tests rather than
  once: 631.8 km² before and after the buffer memo, 31.9 km² before and after the clip memo.
- **Every `addStep` shape matches what `computeElimination` reads.** This was the highest-value
  check of the cycle-2 review, because a mismatch means a committed question that silently
  eliminates nothing or the wrong thing — and my own game-test harness hit exactly that class of
  error twice (passing `{warmer}` where `{side}` was read, and the `lineGeometry` wrapper where
  its `.geometry` was read), which is what led to C1-7. Cross-checked call site by call site
  across `layers.js` and `tools.js`: Matching nearest `{featureIndex, keep}`, Matching nameLength
  `{length, match}` with `.len` on the features, Matching nearestLine `{lineId, match}` resolved
  by `findIndex`, Tentacles `{featureIndex, none}`, and every Measuring mode. **No mismatches.**
- **Sheet cleanup on every exit path** — `_nearestLineSheet` and the sourced-lines path both pass
  `onClose` handlers that clear their overlays. No leak found.
- **No remaining render-blocking awaits in `layers.js`.** The sheets that do await before opening
  await the data the sheet is made of, which is not the P1 mistake — P1 blocked on a note nothing
  in the sheet depended on.
