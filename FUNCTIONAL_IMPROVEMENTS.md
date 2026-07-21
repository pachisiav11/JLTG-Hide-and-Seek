# Functional Improvements — post-3-game playtest + code review

Compiled 2026-07-21. Basis: three end-to-end integration games in
`test/game-full-playtest.test.mjs` covering all 12 §A/§B/§C phases together,
plus a high-effort code review over the §C additions (phases 8-12).

The 498-test suite (498 pass, 0 fail) confirms every phase works IN ISOLATION.
The items below are things that surface only when the phases are asked to
compose during a real game — or that surface if you push a phase with the
kind of input a bad-luck playtest tends to produce.

Every item names the file and the line it lives at, and describes the
concrete failure a real playtest would see. Ordered by severity.

---

## Must-fix (correctness — confirmed)

### 1. Live-share crash on "pin only" mode
**Where:** `src/live-share.js:128`

`_onSeekerPing` dereferences `out.state.distance`, but `evaluateApproach`
returns `state=null` when `thresholdM=0` — the exact setting the "Off (pin
only)" radio in `games.js:525` writes. First ping in that mode throws
`TypeError: Cannot read properties of null (reading 'distance')` and the
hider's live-share stops working for the rest of the game with no
user-visible reason.

**Fix:** either short-circuit before the state dereference when threshold=0,
or have `evaluateApproach` always return a populated `state` (with
`inside=false, distance` computed) even when the alert is disabled — the pill
still wants the distance number.

### 2. Bulk elimination silently reverses a manual station elimination
**Where:** `src/stations.js:168` (whole-line), `src/stations.js:250` (range)

Both bulk eliminators write `s.eliminatedBy = 'line:<key>'` (or `:range`)
unconditionally, even for stations already flagged `eliminatedBy: 'manual'`.
The seeker's manual deduction from an earlier clue gets its tag rewritten,
and the next `restoreStationsOnLine` / `restoreStationsInRange` un-eliminates
it — the manual state is lost forever. The docstring at
`src/stations.js:158-162` explicitly promises this cannot happen.

The existing test `game 4` in `test/game-line-elimination.test.mjs`
appears to cover this but doesn't: the manually-flagged station sits 420 m
off the line at the default 100 m tolerance, so the on-line collision
path is never actually exercised.

**Fix:** in the bulk eliminators, `if (s.eliminatedBy === 'manual') continue;`
Add a real integration test that puts a manually-eliminated station ON the
line and asserts the tag survives a bulk eliminate + restore.

### 3. Session-error is emitted by the server but nobody listens
**Where:** `src/live-share.js:82` (seeker), `src/live-share.js:110` (hider)

`server.js:257-262` emits `session-error` for a bad code or wrong role, and
`session-joined` on success. Neither `startAsSeeker` nor `startAsHider`
subscribes to either. On a mistyped code, seeker keeps publishing to a room
they never joined and hider keeps waiting forever, with the pill lying about
success.

**Fix:** register a `session-error` listener at start, surface the error on
the pill or via `toast()`, and tear down. A `session-joined` listener is a
nice extra to confirm connected state, but the error path is the actual bug.

### 4. Preview readout says "0 of 0" when everything is already eliminated
**Where:** `src/stations.js:305`

`countStationsInEliminated` divides only over non-eliminated stations. When
none remain, the B1 draft preview renders "0 of 0 active stations", which
carries no signal at all. Also fragile if a future caller ever percentages it.

**Fix:** return `null` (or an explicit `{empty: true}` sentinel) when
`total === 0`, and let the sheet render "no active stations left".

---

## Should-fix (correctness — plausible in real play)

### 5. Stale service worker eats geofence notifications during upgrade window
**Where:** `src/geofence.js:188`

The install handler in `service-worker.js` intentionally does NOT
`skipWaiting()` (Phase 12 behaviour: show an update banner instead). But the
geofence's SW-first path sets `sent=true` and returns as soon as
`sw.ready.then(...)` runs, so if the CURRENTLY active SW is a pre-v75 build
without the `GEOFENCE_NOTIFY` handler, the postMessage lands in a void and
the page-side `new Notification(...)` fallback is skipped.

Result: the very first game after an update — the moment the alert matters
most — silently drops geofence notifications until the tab is force-refreshed.

**Fix:** check `event.data?.type` handling on the SW side via a ping/pong
(round-trip). Or, less clever: only trust the SW path when a version marker
in the SW confirms Phase 9+. Cheapest fallback: after a short timeout with
no delivery ack, fire the page notification too — a duplicate is better than
silence.

### 6. Server accepts nonsense coordinates on the relay
**Where:** `server.js:275`

`Number.isFinite(payload.lat)` passes for `1e5` or `-9999`. A rogue or
buggy client can publish coordinates far off the globe; the hider's client
computes a giant distance, corrupts the pill readout, and future code that
plots the pin would jump to nowhere.

**Fix:** enforce `-90 ≤ lat ≤ 90` and `-180 ≤ lng ≤ 180` on the server
before broadcasting.

### 7. No rate limit on `share-location`
**Where:** `server.js:266-278`

The relay accepts unbounded emissions from a joined seeker. A bad client (or
someone who guessed a session code) can flood the hider with pings, and if
they jitter the coordinates across the alert threshold they defeat Phase 12's
once-per-crossing debounce entirely.

**Fix:** simple token bucket per socket — e.g. cap `share-location` at 4/s
per socket. Drop excess silently.

---

## Nice-to-fix (cleanup)

### 8. Dead import in `live-share.js` — CLEARED by Phase 15
**Where:** `src/live-share.js:17`

`import { getPalette } from "./palette.js";` — not referenced anywhere in
the file. Delete.

**Status (2026-07-21):** already gone. Phase 15 (commit `3270fbd`) dropped
this import incidentally while wiring the session-error listener. Grep
confirms no reference remains anywhere in the file. No further code
change needed.

### 9. Haversine-lite duplicated between geofence and live-share
**Where:** `src/live-share.js:27` vs `src/geofence.js:41-47`

Both files carry the same equirectangular-lite distance formula. If one is
ever improved (proper haversine for cross-hemisphere correctness) the other
will silently disagree.

**Fix:** move `metresBetween(a, b)` to `src/geo.js` and import both call
sites from there.

---

## Observations from the 3-game playtest (not from code review)

### 10. Autosave races the test tear-down
`store.setCurrent(game)` schedules a save that fires 500 ms later, after the
test process has already moved on. In Node the save errors out on
"IndexedDB is not available in this browser" and prints a stack. In the
browser this is benign, but the noise in test output is misleading. Consider
either exporting a `store.reset()` for tests to call, or letting `setCurrent`
skip scheduling when running under `node:test`.

### 11. High-accuracy GPS every 60 s is a heavy battery pattern
`src/live-share.js:96` calls `getCurrentPosition({enableHighAccuracy: true})`
on a 60-second timer for a game that runs 45+ minutes. On Android that keeps
GPS hot the whole session. A `watchPosition` + client-side throttle on the
seeker's emit cadence would cost less battery for the same freshness. Not a
bug — a real cost during a real playtest.

### 12. Live-share pill formatting for round threshold values
`src/live-share.js:130` prints "2000 m" when the threshold is 2 km — because
the ternary `threshold >= 1000` uses `.toFixed(1)` on the km path but leaves
the metres path unformatted. Minor readability nit; the pill already reads
km for the seeker's distance.

### 13. Google Maps mobile long-press semantics need a real device test
`src/notes.js:66` wires `mousedown`+`mouseup`+`dragstart` for the note pin.
Whether this catches long-press cleanly on iOS Safari vs Chrome-on-Android
is not covered by any headless test — the whole flow depends on how Google
Maps synthesises pointer events for touch. Recommend a manual playtest of
the note-pin flow on both platforms before relying on it during a game.

**Status (2026-07-21):** documented as a required manual step. The C1
section of `PLAYTEST_IDEAS.md` now carries a 4-step device-verification
checklist (iOS Safari + Chrome Android, long-press drops a pin, short
tap does not, fix location if either platform misses). No code change —
the fix path (Pointer Events or an added `touchstart` pair in
`src/notes.js`) is documented but not applied until a real device shows
the current wiring failing.

---

## Fix-order recommendation

Ship in this order — each is a small, independent commit that can carry a
targeted new test:

1. **#1** live-share NRE — one line, blocks a real setting the UI offers.
2. **#3** session-error listener — one listener + a pill message; low risk.
3. **#2** bulk-elim manual-tag preservation — needs the new integration test
   that the existing "game 4" test doesn't actually exercise.
4. **#4** count-stations empty case — trivial null return + a caller update.
5. **#5** SW upgrade-window notification loss — a version handshake or
   duplicate-fallback strategy.
6. **#6** server coord range check — one guard.
7. **#7** server rate limit — small piece of new state per socket.
8. **#8, #9** cleanup — bundle into one refactor commit.
9. **#10-13** observations — decide per-item what to formalise.

Every item above has a concrete failure scenario that a future test would
pin. The `test/game-full-playtest.test.mjs` file is the natural home for the
integration tests that would catch #2 and (with a mocked SW controller) #5.
