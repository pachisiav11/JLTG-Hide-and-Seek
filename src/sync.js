// Phase 13 — live multiplayer sync (client).
//
// Design: MULTIPLAYER_DESIGN.md. The relay ([server.js]) is a Socket.IO room keyed by
// a session code; it forwards semantic game events and caches a snapshot for late
// joiners — it is a relay, NOT a store. IndexedDB stays each device's source of truth.
//
// This module:
//  - loads the Socket.IO client from the backend (no build step; served at
//    /socket.io/socket.io.js) and connects,
//  - derives coarse SEMANTIC events by diffing the store against the last synced
//    state (so no mutation site needs instrumenting), and applies inbound events
//    through the SAME store mutations (idempotent, echo-suppressed),
//  - queues events in an IndexedDB `outbox` when offline and flushes on reconnect,
//  - reconciles via snapshots on join / when a new peer appears.
//
// Concurrency is mostly free: steps/zones have unique ids and `computeActiveArea`
// is order-independent, so two devices adding questions never conflict (union by id);
// scalars (hider, name) are last-writer-wins.
import * as store from "./store.js";
import * as db from "./db.js";
import { normalizeGame } from "./model.js";
import { unionRings } from "./geo.js";

const LS_DEVICE = "jltg.deviceId";
const LS_SESSION = "jltg.session";

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function clone(o) {
  return o == null ? o : (typeof structuredClone === "function" ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
}

// Resolve the backend URL. Multiplayer reuses the Phase 10 backend service, so
// MULTIPLAYER_URL falls back to OVERPASS_PROXY_URL (they're the same Express app).
function backendUrl() {
  const c = window.JLTG_CONFIG || {};
  return c.MULTIPLAYER_URL || c.OVERPASS_PROXY_URL || "";
}

let ioLoader = null;
// Load the Socket.IO browser client from the backend (matches the server version).
function loadIo(base) {
  if (window.io) return Promise.resolve(window.io);
  if (ioLoader) return ioLoader;
  ioLoader = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = base.replace(/\/+$/, "") + "/socket.io/socket.io.js";
    s.async = true;
    s.onload = () => (window.io ? resolve(window.io) : reject(new Error("socket.io client did not load")));
    s.onerror = () => reject(new Error("Couldn't load the multiplayer client from the backend."));
    document.head.appendChild(s);
  });
  return ioLoader;
}

export class Sync {
  constructor() {
    this.deviceId = localStorage.getItem(LS_DEVICE) || uid("dev");
    localStorage.setItem(LS_DEVICE, this.deviceId);
    this.socket = null;
    this.session = null;      // { code, role, isHost }
    this.connected = false;
    this.lamport = 0;
    this._last = null;        // last-synced game snapshot (for diffing)
    this._applying = false;   // guard: don't re-emit while applying a remote event
    this.members = [];
    this._statusFns = new Set();
    // Tombstones: ids removed in this session. They make removals convergent — a
    // stale snapshot can otherwise resurrect a zone/step another device deleted,
    // because merge/adopt union collections by id. A tombstoned id is never re-added.
    this._tombZones = new Set();
    this._tombSteps = new Set();
  }

  isConfigured() { return !!backendUrl(); }
  inSession() { return !!this.session; }

  onStatus(fn) { this._statusFns.add(fn); return () => this._statusFns.delete(fn); }
  _status() {
    const st = { connected: this.connected, session: this.session, members: this.members, deviceId: this.deviceId };
    for (const fn of this._statusFns) { try { fn(st); } catch (e) { console.error(e); } }
  }

  init() {
    // Derive + relay local changes by diffing the store against the last synced state.
    store.subscribe(() => { if (this.session && !this._applying) this._diffAndEmit(); });
    // Optional auto-rejoin after a reload.
    try {
      const saved = JSON.parse(localStorage.getItem(LS_SESSION) || "null");
      if (saved?.code && backendUrl()) this.join(saved.code, saved.role || "seeker").catch(() => {});
    } catch (_) {}
  }

  async _connect() {
    const base = backendUrl();
    if (!base) throw new Error("Multiplayer isn't configured (set MULTIPLAYER_URL or OVERPASS_PROXY_URL).");
    if (this.socket) return this.socket;
    const io = await loadIo(base);
    this.socket = io(base, { transports: ["websocket", "polling"] });
    this.socket.on("connect", () => { this.connected = true; this._status(); this._flushOutbox(); });
    this.socket.on("disconnect", () => { this.connected = false; this._status(); });
    this.socket.on("event", (event) => this._applyEvent(event));
    this.socket.on("presence", (p) => {
      this.members = p.members || this.members;
      // A new peer joined → the host re-offers a fresh snapshot so late joiners sync.
      if (p.joined && this.session?.isHost) this._emitSnapshot();
      this._status();
    });
    return this.socket;
  }

  // Create a session: server assigns us host; we seed the room with our snapshot.
  async create(role = "hider") {
    const code = uid("s").slice(-4).toUpperCase().replace(/[^A-Z0-9]/g, "X");
    return this.join(code, role, { creating: true });
  }

  async join(code, role = "seeker") {
    code = String(code).toUpperCase();
    await this._connect();
    return new Promise((resolve, reject) => {
      this.socket.emit("session.join", { code, role, deviceId: this.deviceId }, (ack) => {
        if (!ack?.ok) { reject(new Error(ack?.error || "Join failed.")); return; }
        this.session = { code, role, isHost: ack.isHost };
        this.members = ack.members || [this.deviceId];
        localStorage.setItem(LS_SESSION, JSON.stringify({ code, role }));
        if (ack.snapshot) {
          this._adopt(ack.snapshot);        // joining an existing session → adopt its game
        } else {
          this._last = clone(store.getCurrent());
          this._emitSnapshot();             // first in the room → seed my current game
        }
        this._status();
        resolve(this.session);
      });
    });
  }

  leave() {
    if (this.socket && this.session) this.socket.emit("session.leave");
    this.session = null;
    this.members = [];
    this._tombZones.clear();
    this._tombSteps.clear();
    localStorage.removeItem(LS_SESSION);
    this._status();
  }

  // ---- Outbound: diff the store and emit semantic events --------------------
  _diffAndEmit() {
    const cur = store.getCurrent();
    if (!cur) return;
    const last = this._last || { zones: [], history: [], hiderLock: null, name: null };
    const lastZoneIds = new Set((last.zones || []).map((z) => z.id));
    const curZoneIds = new Set(cur.zones.map((z) => z.id));
    for (const z of cur.zones) if (!lastZoneIds.has(z.id)) this._emit("zone.add", { zone: z });
    for (const z of last.zones || []) if (!curZoneIds.has(z.id)) { this._tombZones.add(z.id); this._emit("zone.remove", { id: z.id }); }

    const lastSteps = new Map((last.history || []).map((s) => [s.id, s]));
    const curSteps = new Map(cur.history.map((s) => [s.id, s]));
    for (const s of cur.history) {
      const prev = lastSteps.get(s.id);
      if (!prev) this._emit("step.add", { step: s });
      else if (prev.enabled !== s.enabled || prev.title !== s.title) this._emit("step.update", { id: s.id, enabled: s.enabled, title: s.title });
    }
    for (const s of last.history || []) if (!curSteps.has(s.id)) { this._tombSteps.add(s.id); this._emit("step.remove", { id: s.id }); }

    if (JSON.stringify(last.hiderLock) !== JSON.stringify(cur.hiderLock)) this._emit("hider.set", { hiderLock: cur.hiderLock });
    if (last.name !== cur.name) this._emit("game.rename", { name: cur.name });

    this._last = clone(cur);
  }

  _emit(kind, payload) {
    const event = { id: uid("evt"), deviceId: this.deviceId, gameId: store.getCurrent()?.id, lamport: ++this.lamport, ts: Date.now(), kind, payload };
    if (this.connected && this.socket) this.socket.emit("event", { code: this.session.code, event });
    else this._queue(event);
  }
  _emitSnapshot() {
    const snap = clone(store.getCurrent());
    // Carry tombstones alongside the game so peers don't resurrect removed ids.
    // `__tomb` is not part of the Game shape; readers extract then strip it.
    if (snap) snap.__tomb = { zones: [...this._tombZones], steps: [...this._tombSteps] };
    this._emit("snapshot", snap);
  }

  // Absorb tombstones carried on an inbound snapshot; returns the game without __tomb.
  _absorbTomb(payload) {
    if (payload && payload.__tomb) {
      for (const id of payload.__tomb.zones || []) this._tombZones.add(id);
      for (const id of payload.__tomb.steps || []) this._tombSteps.add(id);
      const { __tomb, ...game } = payload;
      return game;
    }
    return payload;
  }

  // ---- Inbound: apply a remote event through the same store mutations --------
  _applyEvent(event) {
    if (!event || event.deviceId === this.deviceId) return; // echo suppression
    if (event.lamport > this.lamport) this.lamport = event.lamport; // clock catch-up
    this._applying = true;
    try {
      if (event.kind === "snapshot") { this._merge(event.payload); }
      else store.update((g) => this._applyToGame(g, event));
    } catch (e) {
      console.error("apply event failed", event?.kind, e);
    }
    this._applying = false;
    this._last = clone(store.getCurrent());
  }

  _applyToGame(g, event) {
    const p = event.payload || {};
    switch (event.kind) {
      case "zone.add":
        if (this._tombZones.has(p.zone.id)) break; // don't resurrect a removed zone
        if (!g.zones.some((z) => z.id === p.zone.id)) { g.zones.push(p.zone); g.gameArea = unionRings(g.zones.map((z) => z.polygon)); }
        break;
      case "zone.remove":
        this._tombZones.add(p.id);
        g.zones = g.zones.filter((z) => z.id !== p.id); g.gameArea = unionRings(g.zones.map((z) => z.polygon));
        break;
      case "step.add":
        if (this._tombSteps.has(p.step.id)) break; // don't resurrect a removed step
        if (!g.history.some((s) => s.id === p.step.id)) g.history.push(p.step);
        break;
      case "step.update": {
        const s = g.history.find((x) => x.id === p.id);
        if (s) { s.enabled = p.enabled; s.title = p.title; }
        break;
      }
      case "step.remove":
        this._tombSteps.add(p.id);
        g.history = g.history.filter((s) => s.id !== p.id);
        break;
      case "hider.set":
        g.hiderLock = p.hiderLock;
        break;
      case "game.rename":
        g.name = p.name;
        break;
    }
  }

  // Adopt a whole snapshot (used on JOIN): replace local game with the host's.
  _adopt(snapshot) {
    snapshot = this._absorbTomb(snapshot);
    this._applying = true;
    const g = normalizeGame(snapshot);
    // Honour tombstones the host advertised (an id it already deleted must not return).
    g.zones = g.zones.filter((z) => !this._tombZones.has(z.id));
    g.history = g.history.filter((s) => !this._tombSteps.has(s.id));
    store.setCurrent(g);
    this._applying = false;
    this._last = clone(store.getCurrent());
  }

  // Merge a snapshot into the current game (used for in-session reconciliation):
  // union collections by id, last-writer-wins on scalars. Convergent + idempotent.
  // Tombstoned ids are never re-added (removals win over a stale snapshot).
  _merge(snapshot) {
    snapshot = this._absorbTomb(snapshot);
    store.update((g) => {
      // Drop anything locally present that has since been tombstoned.
      g.zones = g.zones.filter((z) => !this._tombZones.has(z.id));
      g.history = g.history.filter((s) => !this._tombSteps.has(s.id));
      const zoneIds = new Set(g.zones.map((z) => z.id));
      for (const z of snapshot.zones || []) if (!this._tombZones.has(z.id) && !zoneIds.has(z.id)) g.zones.push(z);
      const byId = new Map(g.history.map((s) => [s.id, s]));
      for (const s of snapshot.history || []) {
        if (this._tombSteps.has(s.id)) continue;
        if (byId.has(s.id)) Object.assign(byId.get(s.id), s);
        else g.history.push(s);
      }
      if (snapshot.hiderLock) g.hiderLock = snapshot.hiderLock;
      if (snapshot.name) g.name = snapshot.name;
      g.gameArea = unionRings(g.zones.map((z) => z.polygon));
    });
  }

  // ---- Offline outbox (IndexedDB, flush on reconnect) -----------------------
  async _queue(event) {
    try { await db.put("outbox", { id: event.id, code: this.session?.code, event }); } catch (e) { console.warn("outbox queue failed", e); }
  }
  async _flushOutbox() {
    let rows = [];
    try { rows = await db.getAll("outbox"); } catch (_) { return; }
    rows.sort((a, b) => (a.event.lamport || 0) - (b.event.lamport || 0));
    for (const row of rows) {
      if (row.code && row.code !== this.session?.code) { await db.del("outbox", row.id); continue; }
      this.socket.emit("event", { code: row.code || this.session?.code, event: row.event });
      await db.del("outbox", row.id);
    }
  }
}
