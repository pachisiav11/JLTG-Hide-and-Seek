# Phase 13 — Live Multiplayer Sync — Design Doc

> **Status: IMPLEMENTED (v1), 2026-07-09** — the review gate was explicitly overridden
> by the developer after Phases 7–12 were assured working in-browser. Built per this
> doc with two pragmatic v1 choices noted below; end-to-end verified (server relay +
> snapshot + presence via two headless clients; a real browser client connecting to
> the live relay, applying inbound events, suppressing echoes, and streaming its local
> `zone.add`/`step.add` edits to a joined peer).
>
> **v1 deviations from the pure design (intentional, documented):**
> 1. **Events are DIFF-DERIVED, not instrumented at each mutation site.** `src/sync.js`
>    subscribes to the store and diffs the game against the last synced state to emit
>    `zone.add/remove`, `step.add/update/remove`, `hider.set`, `game.rename`. This keeps
>    the tool flows untouched (no call-site changes) and applies inbound events through
>    the same `store.update` path (idempotent, echo-suppressed by `deviceId`).
> 2. **Snapshot reconciliation uses union-merge, not a full Lamport CRDT.** On join a
>    peer ADOPTS the host snapshot; in-session snapshots MERGE (union collections by id,
>    last-writer-wins on scalars). Concurrent `step.add`s still never conflict (the
>    reason in §3 holds). A Lamport clock is carried on events for future ordering work.
>
> **Update — tombstones added (removals now convergent).** Each device keeps
> per-session **tombstone** sets of removed zone/step ids (`Sync._tombZones` /
> `_tombSteps`). A tombstoned id is never re-added by `_merge`/`_adopt` or a late
> `*.add`, and tombstones ride along on snapshots (`payload.__tomb`) so a peer that
> deleted an id propagates that deletion even to a joiner holding a stale snapshot.
> This closes the one gap noted in §3 ("simultaneous removals can lose to a merge").
> Verified headless (6/6): a stale snapshot no longer resurrects a removed step, an
> advertised tombstone removes the id on a peer that still has it, and normal
> add/echo-suppression behaviour is unaffected.
>
> Original gate (now satisfied): *this phase changes the "no server, no account" premise
> in [GUIDE.md](GUIDE.md) §2* — §2 has been amended to "no account, optional relay."

This is the single largest capability gap versus the `gelbh/jetlag` reference (session
code + live sync across seeker/hider devices). The goal: two or more devices in the
same game see each other's zones, questions, and the shrinking active area **live**,
while each device keeps working offline and never loses data.

---

## 1. Scope & non-goals

**In scope**
- A **session** two+ devices join with a short code, with **roles** (`hider` / `seeker`).
- **Live relay** of the events that mutate a game: zones added/removed, questions
  added/toggled/removed/renamed, hider zone changes, active-area recompute triggers.
- **Offline resilience**: a device that drops offline queues its own edits and replays
  them on reconnect; IndexedDB stays the per-device source of truth.

**Non-goals (explicitly out)**
- No accounts, no login, no cloud database of games. The relay is a **relay, not a
  store** (same as Circuit): the server forwards events between devices in a room and
  holds only ephemeral in-memory session state. Each device persists to its own
  IndexedDB exactly as today.
- No change to the Google Maps engine, the elimination math, or the manual-answer
  model. Multiplayer layers *on top of* the existing `Game` model.
- Not a spectator/web-embed mode; both devices run the existing PWA.

---

## 2. Session & role model (layered on the existing `Game`)

The existing data model ([src/model.js](src/model.js)) is unchanged on disk. We add a
**transient, non-persisted** session envelope held in memory + a tiny bit of
`localStorage` for reconnect:

```jsonc
Session {              // NOT stored in the game record; lives in memory + localStorage
  code: "4F7Q",        // short join code (room key)
  role: "hider" | "seeker",
  gameId: "game_…",    // the local Game this session is bound to
  deviceId: "dev_…",   // stable per-device id (localStorage), for echo suppression
  hostDeviceId: "dev_…",// the device that created the session (tie-breaker authority)
}
```

- **Creating** a session: a device picks a code (or the server assigns one), becomes
  `host`, and broadcasts a **snapshot** of its current `Game` so joiners start in sync.
- **Joining**: a device enters the code + picks a role, receives the host snapshot,
  writes it to its own IndexedDB as the session's `gameId`, and starts applying events.
- **Roles** are advisory for UX (e.g. the hider device can hide the hider-zone overlay
  from seekers, or seekers can't see the hider's true point) — they do **not** change
  the geometry engine. A first cut can treat both roles identically and just label them;
  role-based redaction (hide the hider's point from seekers) is a fast-follow.

### Event model

Every mutation already goes through `store.update(...)` and the tool flows. We route
those through a thin **event log** so they can be both applied locally and relayed:

```jsonc
Event {
  id: "evt_…",         // uuid, for idempotent apply + echo suppression
  deviceId: "dev_…",   // origin device
  gameId: "game_…",
  lamport: 42,          // per-session Lamport clock for ordering
  ts: 1720000000000,
  kind: "zone.add" | "zone.remove" | "step.add" | "step.toggle" | "step.remove"
       | "step.rename" | "hider.set" | "hider.radius" | "game.snapshot",
  payload: { … }        // the minimal data to reproduce the mutation
}
```

Events are **coarse-grained and semantic** (mirroring Circuit's game-move events,
adapted from chess-like moves to JLTG `Step`/zone/annotation events), not CRDT
character-level deltas — the objects are small and edits are infrequent, so semantic
events keep the server dumb and the client logic simple.

---

## 3. Conflict handling (concurrent zone/step edits)

Because steps are **individually toggleable and order-independent already**
(`computeActiveArea` is a pure set-difference — [src/tools.js](src/tools.js)), most
concurrency is naturally benign:

- **`step.add` from two devices**: both steps append; each has a unique `id`. No
  conflict — the active area is the difference of the union of all enabled eliminations,
  independent of arrival order. ✅ (This is the big win from the existing architecture.)
- **`step.toggle` / `step.remove` / `step.rename` on the same step**: last-writer-wins
  keyed by `(lamport, deviceId)` — apply the event with the higher Lamport; ties broken
  by `deviceId` string order. Idempotent: applying the same `evt_id` twice is a no-op
  (track applied ids per session).
- **`zone.add`**: append (unique id), then recompute `gameArea = union(zones)` locally —
  order-independent like steps.
- **`zone.remove`**: last-writer-wins on that zone id; removing an already-removed zone
  is a no-op.
- **`hider.set` / `hider.radius`**: single logical value → last-writer-wins by Lamport.
- **Snapshot reconciliation**: on (re)join or a detected gap in Lamport clocks, a device
  requests a fresh `game.snapshot` from the host and replaces local state wholesale
  (the host is the tie-break authority). Snapshots are the recovery path; steady-state
  runs on incremental events.

No character-level merge is needed; the coarse semantic events + LWW-on-scalars +
append-on-collections cover the real cases.

---

## 4. Backend — Render Node + Socket.IO (Circuit pattern)

Following **Circuit** (the developer's prior Express + Socket.IO relay deployed on
Render's free tier), the relay is a single Node Web Service. **It reuses the Phase 10
Express app** — one service serves both the `/overpass` proxy route *and* the Socket.IO
relay, rather than two services, unless load/isolation later argues for splitting them.

### `server.js` additions (sketch — not yet built)

```js
import { createServer } from "http";
import { Server } from "socket.io";
// … existing express app with /overpass …
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: process.env.ALLOW_ORIGIN || "*" } });

// Ephemeral in-memory session state only (relay, not store).
const sessions = new Map(); // code -> { hostDeviceId, members:Set, lastSnapshot }

io.on("connection", (socket) => {
  socket.on("session.join", ({ code, role, deviceId }, ack) => {
    socket.join(code);
    const s = sessions.get(code) || { hostDeviceId: deviceId, members: new Set(), lastSnapshot: null };
    s.members.add(deviceId); sessions.set(code, s);
    ack?.({ ok: true, host: s.hostDeviceId, snapshot: s.lastSnapshot });
    socket.to(code).emit("presence", { deviceId, role, joined: true });
  });

  socket.on("event", ({ code, event }) => {
    if (event.kind === "game.snapshot") { const s = sessions.get(code); if (s) s.lastSnapshot = event.payload; }
    socket.to(code).emit("event", event);         // relay to everyone else in the room
  });

  socket.on("disconnect", () => { /* presence-leave, GC empty sessions */ });
});
httpServer.listen(PORT);
```

Key properties: rooms keyed by session code (Circuit's structure); the server keeps
only the last snapshot + membership in memory; if it restarts, clients recover by
re-emitting a snapshot from the host. No API key, no DB.

### `render.yaml`

The existing backend service ([render.yaml](render.yaml)) already has the right shape;
Phase 13 only adds the `socket.io` dependency and (if needed) confirms WebSocket
support (Render Web Services support WebSockets by default). Same blueprint fields as
Circuit: `type: web`, `runtime: node`, `plan: free`, `buildCommand: npm install`,
`startCommand: npm start`.

---

## 5. Client — offline-resilient sync (gelbh `offlineQueue` pattern)

Reference: gelbh's `offlineQueue` (IndexedDB-backed write queue, retry with backoff,
capped failure count). JLTG already persists to IndexedDB, so the design keeps
**IndexedDB as the per-device source of truth** and treats the socket as best-effort:

- A new `src/sync.js` module wraps the socket. Every local mutation:
  1. applies to the store as today (instant, offline-first),
  2. is appended to an **outbox** (a new IndexedDB store `outbox`, keyed by `evt_id`),
  3. is emitted over the socket if connected.
- On `connect` / reconnect, the outbox is flushed in Lamport order with exponential
  backoff; a delivered event (server ack or echo) is removed from the outbox. A capped
  retry count surfaces a "couldn't sync N changes" banner rather than looping forever.
- Inbound events are applied through the **same** `store.update` mutations used locally
  (idempotent by `evt_id`), so there is one code path for local and remote edits.
- Echo suppression: ignore inbound events whose `deviceId === myDeviceId`.

### UI

- A **Multiplayer** entry in the ☰ menu: Create session (shows code + role) / Join
  session (enter code + pick role) / Leave. A small presence chip shows connected peers.
- Role redaction (optional fast-follow): on seeker devices, don't render the hider's
  true point overlay ([src/hider.js](src/hider.js)) — only the shaded zone.

---

## 6. Data-model / storage changes

- **New IndexedDB store `outbox`** (DB_VERSION bump, guarded `onupgradeneeded` like the
  Phase 9 `categories`/`pins` stores in [src/db.js](src/db.js)).
- **New `localStorage`**: `jltg.deviceId`, and the active `jltg.session` (code+role) for
  reconnect across reloads.
- **No change** to the `Game` record shape on disk — sessions are transient.

---

## 7. Rollout plan (once this doc is approved)

1. `sync.js` + `outbox` store + `deviceId`; wire local mutations to the outbox (no
   socket yet) — proves the event log + idempotent apply against the existing store.
2. Add Socket.IO to the existing Express service; implement `session.join` + `event`
   relay + snapshot; deploy alongside `/overpass`.
3. Client Create/Join/Leave UI + presence; connect the outbox flush to the socket.
4. Snapshot reconciliation + reconnect/backoff; the "couldn't sync" banner.
5. Optional: role-based redaction of the hider's point from seekers.
6. Update GUIDE.md §2 (the "no server, no account" row) + §11, and the README status.

---

## 8. Open questions for review

1. **Same service vs. separate service** for the Socket.IO relay and the Overpass
   proxy — this doc recommends the **same** Express app (simpler, one free Render
   service). Confirm?
2. **Role redaction** in v1 or fast-follow? (Recommend fast-follow — ship symmetric
   sync first.)
3. **Session code source** — server-assigned vs. host-chosen. (Recommend server-assigned
   to avoid collisions.)
4. **Free-tier spin-down**: Render free Web Services sleep when idle; first connect
   after idle has a cold-start delay. Acceptable for casual play? (The offline queue
   makes this a non-blocker — edits aren't lost during the wake-up.)

**→ Please review §§2–4 and the open questions in §8 before any implementation code is
written (Phase 13, step 4).**
