# Performance & result review — 2026-07-18

Scope, as asked: **only defects that cost time or change an answer during play.** Not style,
not naming, not dead code — that was [`AUDIT_2026-07-18.md`](AUDIT_2026-07-18.md), and every
item in it is now closed. This is a fresh read of the nine commits from `54e725d..HEAD`
(1,661 insertions across 28 files) plus the code they touch.

Every number below was **executed against this repo** in the running app on a live Mumbai
board, against the local Overpass proxy and real Google Places. Where a suspicion did not
survive measurement it is recorded in [Checked and cleared](#checked-and-cleared) rather than
quietly dropped — a review that only lists confirmed hits hides how much of it was guesswork.

| | finding | cost | where | severity |
|---|---|---|---|---|
| **P1** | Admin-division trace sheet blocks on ~25 Overpass probes | **~38 s**, once per board | `layers.js:_adminTracePrompt` | high |
| **P2** | `candidateLines` computes 2,109 distances it then discards | **213 ms** of 220 ms | `lines.js:candidateLines` | high |
| **P3** | Sourced-geometry steps are ~280× a drawn step, rewritten whole on every change | 43 KB/step, ~345 KB games | `store.js:scheduleSave` | medium |
| **P4** | Unfiltered board pays the full fetch + partition, then refuses | ~220 ms + network | `layers.js:_sourcedMatchLines` | medium |
| **P5** | `_mapClaimed` is a boolean where nesting needs a counter | latent wrong result | `features.js:init` | medium |
| **P6** | A refused zone still emits and schedules a save | one wasted write | `zones.js:addZone` | low |

---

## P1. The admin trace sheet now waits ~38 seconds on first use

**This is a regression I introduced today** in the R3/R4 commit (`cdb4812`), and it is the
most expensive thing in this review.

`_adminTracePrompt` awaits `_divisionDefinitionNote(card)` *before* calling `openSheet`:

```js
const note = await this._divisionDefinitionNote(card);   // layers.js
// ... nothing renders until this resolves
const s = openSheet({ ... ${note} ... });
```

`_divisionDefinitionNote` calls `resolveBoardDivisions`, which fires **25 grid probes** at
`/overpass/divisions` (concurrency 5, each with its own deadline). Measured on the Mumbai
board:

```
cold (first use on a board) : 37,769 ms
warm (all 25 probes cached) :      5 ms, 0 network calls
single cached probe         :      1 ms
```

So the cost is paid **once per board** and then effectively free for the 30-day TTL. But the
first time a player taps *Matching ▸ 1st Admin. Division* mid-game, the app renders nothing
for roughly **half a minute** — no sheet, no spinner, no toast. Before this commit that flow
never touched Overpass at all; it opened as fast as a reverse geocode.

> **Measurement note.** My first reading said "cold 38 s, warm 20 s", which would have meant a
> broken cache. It was wrong: the second call overlapped probes still in flight from the first.
> Re-measured after they settled, the cache is fine. The bug is the *blocking*, not the caching
> — and I nearly filed a much more alarming and completely fictional version of this.

**Failure scenario.** Seeker is standing on a street corner with a phone. They tap the 1st
Admin Division card. The app appears frozen for 38 seconds; they tap again, or back out and
retry, which starts a second sweep. The Hide & Seek round has a clock.

**Fix.** Open the sheet immediately with the note area empty, resolve the note in the
background, and inject it when it arrives — the note is advisory, nothing depends on it being
present before the player can act. `_divisionDefinitionNote` already returns `""` on failure,
so an empty slot is a state the markup handles.

---

## P2. `candidateLines` spends 97% of its time on distances it throws away

`_sourcedMatchLines` calls, correctly, with no radius — Matching asks about the whole board:

```js
const out = await candidateLines(card.lineKind, g.gameArea, {lat, lng}, Infinity, { game: g });
```

But `candidateLines` computes the distance from the centre to **every path of every line**
before testing `best <= radius`, and with `radius = Infinity` that test can never fail:

```js
for (const p of l.paths) {
  const d = turf.pointToLineDistance(from, turf.lineString(...), { units: "meters" });
  if (d < best) best = d;
}
if (best <= radius) within.push({ ...l, distance: best });   // always true
```

Measured on the 1,753 km² MMR board, cache warm so this is pure compute:

```
lines                44
paths             2,109
vertices         24,545
candidateLines total  220 ms
the distance loop     213 ms   (97%)
```

**Failure scenario.** Not a wrong answer — a stall. 213 ms of main-thread work on a phone,
blocking the UI, to produce an ordering that `_sourcedMatchLines` does not even display (the
comment there says distances are deliberately not shown, because the app does not know where
the seeker is standing). On a slower device this is the difference between a sheet that opens
and a sheet that hitches.

**Fix.** Skip the loop when the radius is not finite, and sort by label instead of distance:

```js
const unbounded = !Number.isFinite(radius);
// ... if (unbounded) { within.push({ ...l, distance: null }); continue; }
```

The Tentacles caller passes a real radius (2 km / 25 km) and is unaffected.

---

## P3. A sourced-geometry step is ~280× a drawn one, and the whole game is rewritten on every change

Storing geometry rather than a reference is deliberate and correct — the partition must
recompute identically for the life of the game even if OSM is edited. The cost is real though:

```
5 sourced metro lines (inputs.lines)   43.3 KB
2 hand-drawn lines (inputs.lines)       0.155 KB      -> ~280x
1 sourced coastline question (export)  345 KB          (68-segment MultiLineString)
```

`store.update` → `scheduleSave` → `db.put("games", current)` writes the **entire game record**,
not a delta. So with three or four sourced line/coastline questions on a board, every question
toggle, every marker drag, every zone edit re-serialises and rewrites on the order of a
megabyte to IndexedDB.

**Failure scenario.** Late-game board with several sourced questions. Dragging a radar centre
fires `store.update` per drag event; each one serialises ~1 MB. The drag stutters, and on a
low-end phone IndexedDB back-pressure can make it feel like the map has stopped responding.

**Fix (pick one).** Simplify sourced geometry before storing it — `turf.simplify` at a
tolerance well below map resolution would cut the coastline's 68 segments hard without moving
any boundary a player could see. Or debounce `scheduleSave` harder during drags. Or store step
geometry in its own IndexedDB store keyed by step id, so a game write does not carry it.

---

## P4. An unfiltered board does all the work, then refuses

`_sourcedMatchLines` fetches, groups, partitions and *then* checks `MATCH_LINE_LIMIT`:

```js
const out = await candidateLines(...);        // network + 220 ms of compute
...
if (sourced.length > MATCH_LINE_LIMIT) {      // 44 > 8 -> refuse
  toast(`${sourced.length} ... too many to answer. Use 🚄 ...`);
  return false;
}
```

Measured: on both default Mumbai boards this is the path taken (44 lines on MMR, 32 on the
city board), because the rail filter starts empty. So the *common first experience* of this
card is a network round-trip plus 220 ms of geometry, spent entirely to print a refusal.

This is partly inherent — you cannot count the lines without fetching them. But the count is
knowable from `groupIntoLines(data)` before any distance work, so P2's fix largely resolves
this one too.

**Worth flagging separately as a product question:** since the filter starts empty, a player
must visit 🚄 before this card will ever source. That was a deliberate call (documented in
`9b6d321`) but it means the sourced path is unreachable by default, and it may be worth
defaulting `hiddenRoutes` to exclude `train` on a new board.

---

## P5. `_mapClaimed` is a boolean where the flows can nest

The B5 fix (`bc18b6c`) has `features._mapClaimed` set true on `jltg:mapclaim` and false on
`jltg:maprelease`. Claims are not counted:

```js
window.addEventListener("jltg:mapclaim",   () => { this._mapClaimed = true;  });
window.addEventListener("jltg:maprelease", () => { this._mapClaimed = false; });
```

I could not find a path that nests two claims today — `_drawShape` and `pick` are always
awaited before the next begins, and `zones.startDraw` guards on `this._draw`. So this is
**latent, not live**, and it is filed here rather than as a confirmed bug.

**Failure scenario if it ever nests.** Flow A claims; flow B claims and releases; A is still
running with `_mapClaimed === false`, so measure mode starts eating A's taps again — which is
exactly the bug B5 fixed, reappearing only in the nested case and therefore very hard to
attribute.

**Fix.** Make it a depth counter (`this._claims++ / --`, claimed when `> 0`). Three lines, and
it removes the need to keep proving no path nests.

---

## P6. A refused zone still emits and schedules a save

In the B4 fix, `addZone` pushes the zone, discovers the union failed, and pops it — all inside
the `store.update` mutator. `store.update` then unconditionally runs `scheduleSave()` and
`emit()`, so a rejected zone still costs a full game write and a full re-render.

**Failure scenario.** Cosmetic and cheap on its own; it matters only in combination with P3,
where a full game write is expensive. Listed for completeness.

**Fix.** Have `store.update` skip the save/emit when the mutator reports no change, or do the
union check before entering `update`.

---

## Checked and cleared

Recorded so the next pass does not re-derive them.

- **`boardKey()` on every store emit** (B7 fix) — suspected hot-path cost. Measured at
  **0.004 ms per emit** on a 5-vertex board. Not a finding.
- **Rail line cache keyed on bbox string** — I suspected `this.bbox === bbox` might be
  comparing objects and never matching, forcing a refetch per render. `boardBbox` returns a
  **string** (`lines.js:154`), so the comparison is sound. Verified live: a same-board reload
  was a 20 ms cache hit with no network call.
- **Division probe cache not writing** — see the note under P1. It writes correctly; 25 fresh
  entries confirmed in the `lines` store with the expected `divisions|lat|lon` keys.
- **`_nearestLineSheet` drawing one Polyline per path** — up to 8 lines is bounded by
  `MATCH_LINE_LIMIT`, and the Tentacles picker has done the same for a while without trouble.
- **Elimination geometry** — all 307 tests pass, and the full playtest showed every tool
  computing the right area (radar 1 km → 3.1 km² against πr² = 3.14; thermometer → 186.7 of
  379.9). No result bugs found in the geometry engine itself.

## Suggested order

1. **P1** — it is a regression, it is the largest number here, and the fix is to stop awaiting.
2. **P2** — one conditional, and it takes P4's cost down with it.
3. **P3** — needs a decision on which of the three fixes; the simplify option is cheapest.
4. **P5** — three lines, removes a latent class of bug.
5. **P4** product question, **P6** cleanup.
