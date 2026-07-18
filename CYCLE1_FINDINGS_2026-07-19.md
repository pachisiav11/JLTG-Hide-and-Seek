# Cycle 1 findings — 2026-07-19

New findings raised during cycle 1. The P-findings themselves live in
[`PERF_REVIEW_2026-07-18.md`](PERF_REVIEW_2026-07-18.md), whose status column this cycle keeps
current; only things that document did not already name are recorded here.

Every number below was executed in the running app against a live Mumbai board (MMR, 44 rail
lines, 2,109 paths, 24,545 vertices) with the local Overpass proxy on port 3000, or in the test
suite where stated.

| | finding | cost | where | severity | status |
|---|---|---|---|---|---|
| **C1-1** | `store.update` re-renders synchronously on every drag event | 3.55 ms/event, 213 ms per drag | `store.js:update` → `emit` | medium | open |
| **C1-2** | The review's own P4 default would not have worked | would still refuse | `PERF_REVIEW` P4 | — | resolved, not adopted |
| **C1-3** | A thrown zone union leaves the rejected zone on the board | corrupt board | `zones.js:_fold` | high | **fixed** |
| **C1-4** | A coastline question costs ~3.9 s per elimination, uncached, per render | **6,948 ms** per drag event | `tools.js:measuring` | high | open |
| **C1-5** | A failed union mid-fold discards everything folded so far | wrong elimination | `tools.js:310,567` | high | **fixed** |
| **C1-6** | Client-side proxy fetches have no timeout | UI stall | `lines.js:323,443` | medium | open |

---

## C1-1. The per-drag cost is the re-render, not the write

Found while measuring P3, and it is the part of P3's failure scenario that *is* real — just
not for the reason the review gave.

`store.update` calls `emit()` synchronously, and every subscriber re-renders against the whole
game. On a 240.8 KB board carrying three sourced questions:

```
60-event drag burst    212.9 ms total,  3.55 ms per event
same burst, 0.6 KB board 130.3 ms,      2.17 ms per event
IndexedDB writes during the burst        0
```

So the write is already coalesced (that is why P3 is cleared), but the *render* is not. 3.55 ms
per event is comfortably inside a 16 ms frame on this machine, which is why nothing stutters
here — but it scales with board size (2.17 → 3.55 ms as the board went from 0.6 KB to 240.8 KB),
and a low-end phone is several times slower.

**Not yet a confirmed defect.** It has not been shown to drop a frame on any device actually
used to play. Filed so the next pass does not re-derive it, and so that if drag stutter is ever
reported, this is the first place to look rather than the autosave.

**Possible fix if it is ever confirmed:** coalesce `emit` to one call per animation frame, the
same way the save is coalesced to one per 500 ms quiet period. That is a change to a hot,
load-bearing path and is not worth making against a number nobody has felt.

## C1-2. The suggested P4 default was measured and rejected

Recorded because the review proposed it in good faith and a later pass would otherwise pick it
up again. Defaulting `hiddenRoutes` to hide `train` on a new board:

```
live MMR board   44 grouped (35 train + 9 subway)  -> 9 visible, still over MATCH_LINE_LIMIT (8)
repo fixture     13 grouped ( 9 train + 4 subway)  -> 4 visible, under the limit
```

Two captures of the same city, opposite outcomes. Beyond being unreliable it also answers, on
the players' behalf, the one question the rail filter exists to let them answer. The refusal now
offers to open the filter panel instead. Pinned in `test/sourced-match-refusal.test.mjs`.

## C1-3. A thrown zone union left the rejected zone on the board

Found while verifying P6 — a correctness bug, not a performance one, so it got its own phase.

`addZone` pushes the zone, folds, and pops again if the fold failed. But `Zones._fold` handled
only a union that *returned* null, not one that **threw**. The exception propagated out of the
`store.update` mutator, so the `pop()` on the next line never ran:

```js
store.update((g) => {
  g.zones.push(zone);
  const { ok, area } = Zones._fold(g.zones);   // <- threw here
  ...
  g.zones.pop();                               // <- never reached
});
```

Reproduced live: the board went 1 zone → 2, the second being the one just refused, with
`gameArea` never rebuilt to include it. That is the exact opposite of the guard's stated
purpose — *refuse the ZONE rather than lose the BOARD*.

**Narrower than it first looked, and the measurement is why.** Genuinely degenerate rings do
not throw at all; `unionRings` skips them and the fold succeeds:

```
[[19,72],[19,72],[19,72],[19,72]]      identical points -> ok: true
[[19,72],[19.1,72.1]]                  two points       -> ok: true
[[19,72],[19,72.1],[19,72.2],[19,72]]  collinear        -> ok: true
[]  /  null                                             -> ok: true
```

What throws is a ring of the wrong **shape** — `[{lat,lng}]` instead of `[[lat,lng]]` — because
`ringToTurf` destructures each vertex (`geo.js:40`). My first live repro used that shape by
accident, and the honest reading is that no drawing or paste path produces it.

It is still reachable, and that is why it was fixed rather than filed: `validateGame` checks
`Array.isArray(z.polygon)` but never the element shape (`model.js:99`), so an **imported board
file** — a shared game, a hand-edited export, anything third-party — whose zones use the object
shape passes validation, loads, and throws on the next zone edit.

**Fix.** `_fold` converts a throw into the `ok:false` it already had a route for. Not swallowing:
both callers act on `ok` and tell the player in words what happened, and the cause is still
logged. Verified live — the call that previously left a zombie zone now returns `null`, leaves
the board at one zone, and does not throw. Pinned in `test/zone-union-throw.test.mjs`, including
two tests asserting that genuinely degenerate rings are still *tolerated*, so the fix cannot
start refusing boards that work today.

## C1-5. A failed union mid-fold discarded everything folded so far

Raised by the geometry review, confirmed by reading, and pinned by a test that reproduces the
old behaviour rather than only asserting the new one.

`safeUnion` swallows its exception and returns null, so this reads correctly and is wrong:

```js
union = union ? safeUnion(union, c) : c;
```

One failure nulls the accumulator, and the next iteration takes the falsy branch and restarts
from that single geometry. Everything merged so far vanishes, and the elimination built from
the fragment removes the wrong ground with nothing on screen saying so.

This is a **known** bug shape here — `lineCells` was already fixed for it (the A7 note at
`tools.js:409`). It survived in two more places:

- `matchingNameLength` — "which station names are N letters" keeps or removes the union of
  those cells. A reset fold keeps or removes only the cells *after* the failure.
- `tentacles` "none" (legacy, no seeker centre) — the hider is in none of the circles, so the
  union of all of them is eliminated. A reset fold eliminates only the last circle, leaving on
  the board ground the hider has already been ruled out of.

**Fix.** Both go through a new `unionAll`, which keeps the last good accumulator and drops only
the member that would not merge. That under-eliminates instead of eliminating somewhere wrong,
which is the safe direction: a seeker who eliminates too little wastes a question, a seeker who
eliminates the wrong ground loses the hider. It warns when it drops one.

Verified live on the Mumbai board — four disjoint 2 km circles under a "none" answer:

```
eliminated   50.18 km2
4 * pi * r^2 50.27 km2   ratio 0.998 (the 72-step circle approximation)
parts         4          all four present
```

## C1-4. A coastline question costs ~3.9 s to compute, and recomputes on every render

The largest number found in this cycle, and larger than anything in the original review. Found
by running the coastline tool in a real game rather than by reading.

Mumbai's sourced coastline is a 98-part MultiLineString of 5,320 vertices. Buffering it and
differencing against the board is genuinely expensive, and nothing caches it:

```
computeElimination, 1st call      3,954 ms
computeElimination, 2nd call      3,780 ms   <- no caching
computeActiveArea with that step  3,602 ms
ONE store.update on that board    6,948 ms   (median of 3: 7096 / 6873 / 6948)
```

That last number is the one that matters. `computeActiveArea` runs on every `emit`, and `emit`
runs on every `store.update` — so on a board carrying a single coastline question, **every drag
event, every question toggle and every marker move costs about seven seconds.** This is C1-1
(the per-event re-render) multiplied by a step that is four orders of magnitude more expensive
than the ones C1-1 was measured against.

The answer itself is correct — within-3 km and beyond-3 km partition the board exactly
(631.8 + 613.7 = 1,245.5 km²). It is purely a cost.

**Not fixed in this cycle.** The obvious fix is to memoise a step's elimination on its inputs,
which is a change to the hottest, most correctness-critical path in the app and deserves its own
cycle with its own tests rather than being appended to this one. Carried into cycle 2 as the
first phase.

## C1-6. Client-side proxy fetches have no timeout

Raised by the lines review. `fetchFromProxy` (`lines.js:323`) and `loadCountryDivisions`
(`lines.js:443`) both call `fetch` with no `AbortSignal.timeout`, where `overpass.js:56` does
pass one. A hung proxy therefore stalls on the browser's default timeout — a minute or more —
rather than failing to the stale-cache path the ladder was built for.

**Not yet fixed, and not yet measured.** The claim is verified by reading; the failure has not
been reproduced against a deliberately hung proxy, so the "1–2 minutes" figure is the browser
default rather than something observed here. Carried into cycle 2.

---

## Checked and cleared this cycle

- **P3's drag-write scenario** — see the CLEARED block in `PERF_REVIEW_2026-07-18.md`. A 60-event
  drag performs **zero** IndexedDB writes; the trailing debounce already does the coalescing the
  review proposed adding.
- **The division-probe cache** — re-confirmed independently while measuring P1. A cold board
  wrote exactly **25** `divisions|lat|lon` entries, and the warm sheet resolved its note in 5 ms.
  The review's earlier "cache may be broken" worry stays cleared.
- **`_divisionDefinitionNote`'s content** — checked live rather than assumed. On the Mumbai board
  it returns the India note naming `admin_level 4` and pointing at the 1st Admin. Division Border
  card, which is the correct wording for the case where the game's definition and Google's agree.
