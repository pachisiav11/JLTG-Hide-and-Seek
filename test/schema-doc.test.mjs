// B10: db.js's header said "five stores" and then listed — and created — seven, for three
// phases running. A header that is wrong is worse than no header: it is an answer someone
// trusts. This asserts the header against the code so it cannot drift again.
//
// R5/R6: the Socket.IO relay and the `outbox` store it queued for were deleted. Neither ever
// had a client. These check the deletion stayed done.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const dbSrc = read("src/db.js");

const WORD = { four: 4, five: 5, six: 6, seven: 7, eight: 8 };

test("the store count in db.js's header matches the stores it documents", () => {
  const claimed = dbSrc.match(/Database `jltg` with (\w+) stores/);
  assert.ok(claimed, "the header should still state a store count");
  const n = WORD[claimed[1]];
  assert.ok(n, `unrecognised count word "${claimed[1]}"`);
  const listed = [...dbSrc.matchAll(/^\/\/\s+-\s+(\w+)\s+\(keyPath/gm)].map((m) => m[1]);
  assert.equal(listed.length, n, `header claims ${n} stores but lists ${listed.length}: ${listed.join(", ")}`);
});

test("every documented store is actually created, and every created store is documented", () => {
  const listed = new Set([...dbSrc.matchAll(/^\/\/\s+-\s+(\w+)\s+\(keyPath/gm)].map((m) => m[1]));
  const created = new Set([...dbSrc.matchAll(/createObjectStore\("(\w+)"/g)].map((m) => m[1]));
  assert.deepEqual([...created].sort(), [...listed].sort());
});

test("outbox is gone from the schema and dropped on upgrade", () => {
  assert.ok(!/createObjectStore\("outbox"/.test(dbSrc), "outbox must not be created");
  assert.ok(/deleteObjectStore\("outbox"\)/.test(dbSrc), "the upgrade must drop it for existing installs");
});

test("dropping a store came with a DB_VERSION bump", () => {
  const v = Number(dbSrc.match(/const DB_VERSION = (\d+)/)[1]);
  assert.ok(v >= 5, `DB_VERSION is ${v}; deleteObjectStore only runs inside onupgradeneeded`);
});

test("the Socket.IO relay is back, but scoped to §C5's one-way seeker→hider location", () => {
  // This test was originally "the relay is gone" (deleted 2026-07-18 with the removed
  // Phase 13 full-multiplayer flow). Phase 12 (§C5, 2026-07-21) reintroduces a
  // narrow one-way relay for the seeker→hider location share, per the user's
  // explicit rollback of that part of the "no multiplayer" non-goal in
  // PLAYTEST_IDEAS.md. The pin now asserts the scope: relay present, connection
  // handler present, but no game-state sync (share-location + location only).
  const server = read("server.js").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(/from ["']socket\.io["']/.test(server), "server.js should import socket.io for §C5");
  assert.ok(/new\s+SocketIOServer/.test(server), "the relay must be constructed");
  assert.ok(/io\.on\(["']connection["']/.test(server), "a connection handler is required");
  // Guard against scope creep: the only relayed events are the two §C5 defines.
  // Any new topic here should be a conscious phase, not a quiet addition.
  const relayEvents = [...server.matchAll(/\.on\(["']([a-z-]+)["']/g)].map((m) => m[1]).filter((e) => !["connection"].includes(e));
  const allowed = new Set(["join-session", "share-location"]);
  for (const e of relayEvents) assert.ok(allowed.has(e), `unexpected relay event "${e}" — add a phase or remove it`);
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.dependencies["socket.io"], "socket.io should be on the dependency list for §C5");
});

test("only the Maps libraries the app uses are requested up front", () => {
  const libs = read("src/maps.js").match(/const LIBRARIES = \[(.*?)\]/s)[1];
  for (const dead of ["drawing", "visualization"]) {
    assert.ok(!libs.includes(dead), `${dead} is loaded but never referenced`);
  }
  // geometry is load-bearing: features.js uses computeDistanceBetween for the measure readout.
  assert.ok(libs.includes("geometry"));
});
