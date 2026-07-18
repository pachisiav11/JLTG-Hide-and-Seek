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
