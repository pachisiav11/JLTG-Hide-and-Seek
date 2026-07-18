# Cycle 3 findings — 2026-07-19

Cycle 3 completed the memoisation chain the previous two cycles started, then spent its review
budget attacking that chain rather than sweeping new files — the caches are the newest and by far
the riskiest code added across these cycles, because a stale active area is the shaded map a
player reads their answer off.

| | finding | cost | where | severity | status |
|---|---|---|---|---|---|
| **C3-1** | `computeActiveArea` refolded identical eliminations every render | 148.7 ms → 72.4 ms | `tools.js:computeActiveArea` | medium | **fixed** `9220fc1` |
| **C3-2** | Cache tests can pass for the wrong reason | false confidence | test authoring | — | **recorded** |
| **C3-3** | A comment asserted a mutation hazard the code did not guard against | misleading | `tools.js:724` | low | **fixed** |

---

## C3-1. Refolding eliminations that had not changed

Once the per-step eliminations were memoised (C1-4, C2-1), a render that changed nothing relevant
received the **same geometry objects** as the previous one — and the union fold plus the final
difference were redone against them anyway.

Single-entry memo, not a map: the caller is a render loop asking the same question repeatedly,
and the previous board is of no interest once it changes. Compared by identity **in order**, and
on list length, so a toggled, reordered, added or removed step all miss.

`onFail` is deliberately not replayed on a hit. It reports failures found *while folding*; on a
hit no folding happened, the caller already surfaced them on the miss that populated the entry,
and replaying would re-flag the same steps on every frame.

Most of its tests pin the cases where it must **miss**. Verified live on the MMR board:

```
three questions                  31.9 km2
coastline toggled OFF            96.8 km2   missed correctly
toggled back ON                  31.9 km2   restored exactly
radar answer flipped to "out"   233.3 km2   missed correctly
flipped back                     31.9 km2   restored exactly

computeActiveArea   148.7 ms -> 72.4 ms
```

## C3-2. Two cache tests passed for the wrong reason, and it looked exactly like a bug

Not a code defect — a methodology finding, recorded because it cost real time twice and would
have cost a future pass the same.

Both times a test compared two configurations expecting different answers, got identical ones,
and the identical answers looked exactly like a stale cache hit:

- **C2-1's clip test** compared 0.2° and 0.6° boards. Measured, the coastline buffer is 66.36 km²
  and fits entirely inside any board ≥ 0.2°, so both clip to the whole buffer — equal for a real
  reason. Fixed by using 0.1° vs 0.4°, where the board genuinely truncates the buffer.
- **C3-1's toggle test** used two concentric "inside" radars, 5 km and 9 km. A 5 km inside-circle
  sits entirely within a 9 km one, so the wider question removes nothing. Fixed by using "inside
  5 km AND outside 3 km" — an annulus, which genuinely differs.

**The rule worth keeping:** when a cache test compares two configurations, prove they differ
*without* the cache first. Otherwise the test cannot distinguish a stale hit from a correct
equality, and it will either fail spuriously or — much worse — pass while the cache is broken.

---

## The two game tests

### Game 5 — the memo-invalidation game (MMR board, 3 questions)

Recorded under C3-1 above. Its purpose was correctness, not coverage: toggling a question and
flipping an answer must both defeat the memo, and both must restore exactly.

### Game 6 — full sweep on a fresh board (MMR, 1,245.5 km²)

Every tool, on a board built from scratch so nothing was served warm.

| step | active left | ms |
|---|---|---|
| zones (1 zone) | 1,245.5 | — |
| radar 12 km IN | 426.3 | 52.2 |
| thermometer hotter | 203.4 | 56.6 |
| matching region INSIDE | 190.0 | 136.6 |
| tentacles nearest (3 places, 5 km) | 39.6 | 195.3 |
| coastline within 5 km | 18.5 | **7,446** (cold buffer, once per geometry) |

Strictly monotonic, as a set difference must be. The coastline's 7.4 s is the unavoidable cold
buffer for a brand-new geometry object; every render after it is served from the memo.

| | result |
|---|---|
| drag on the finished 5-question board | **260.5 ms** median |
| rail filter | 43 lines → 9 hiding `train`, 34 hidden |
| label ordering | Green Line, Line 1 (1), Line 1 (N1), Line 2 — the numeric sort from P2 |
| undo → redo | 18.5 → 39.6 → **18.5**, exact |
| export → import | 441.3 KB, fresh id, same steps, same area |

**A third data point for C1-2.** This board has 43 rail lines and hiding `train` leaves **9** —
over the limit of 8, like the MMR board and unlike the repo fixture (4) and the city board (8).
Three boards, three different answers. The review's suggested default of hiding `train` on a new
board would have been right on one of them, which is why it was not adopted.

## C3-3. The one thing the adversarial review and I both found

Cycle 3's review budget went entirely on trying to **break** the three memos rather than sweeping
new files — they are the newest code here, and a stale active area is the worst bug available.

The attack brief was explicit: find any path that mutates `inputs.refGeometry` or `gameArea` in
place, any reuse of a geometry object across two logical boards, and any way two different step
lists could present the same `geoms` array by identity. **It could not break any of them**, and
listed what it tried. Independently, I reached the same place from the other direction.

Both of us stopped at the same line — `bufferGeometry`'s comment:

```js
// simplify is destructive on the original; passing a fresh feature is safest.
input = T().simplify(input, { ... });
```

`feat()` only *wraps* the geometry in a Feature; it does not copy the coordinates. So no fresh
feature was ever being passed, and the comment described a guard that was not there. Harmless
before the memos existed. Once the memos key on geometry identity it becomes the single
assumption everything rests on, so it had to be settled rather than believed.

**Measured, twice, on the path that actually runs it.** The first probe used the repo fixture and
proved nothing — 281 vertices is below `BUFFER_SIMPLIFY_THRESHOLD` (500), so `simplify` never
ran. Repeating the coastline to 1,124 vertices makes it run:

```
vertices        1,124  (above the threshold — simplify really executed)
after buffering byte-identical to before
```

`turf.simplify` defaults to `mutate: false` and clones internally. The comment is now corrected to
say what is true and why it matters, and the invariant is pinned by a test rather than left as a
claim in prose.

---

## Checked and cleared this cycle

- **The memo chain does not change answers.** Checked at every step of both game tests, not once:
  the active area matched the pre-memo value at every stage, and the two deliberate
  invalidations (toggle, answer flip) both missed and both restored exactly.
- **Cold cost is unchanged and that is correct.** The memos remove *repeat* work only. A fresh
  board still pays 7.4 s for its first coastline buffer; nothing was made faster by pretending
  otherwise.
- **All three memos survived a dedicated attempt to break them.** Attacked on mutation of
  `refGeometry` and `gameArea`, geometry reuse across boards, and two step lists colliding on
  identity. `gameArea` is only ever assigned (never mutated) at `zones.js:171`, `zones.js:201`
  and `store.js:136`; the `_activeMemo` comparison covers reorder (in-order identity), add/remove
  (length) and board change (identity).
- **Union is commutative here**, so the order-independence `computeActiveArea` documents is real
  and the memo's in-order comparison is stricter than it needs to be — deliberately, since being
  too strict costs a recompute while being too loose costs a wrong answer.
