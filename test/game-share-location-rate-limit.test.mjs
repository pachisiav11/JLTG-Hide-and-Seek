// Phase 19 game test: token-bucket rate limit on the share-location relay.
//
// Regression pin for review finding #7 (2026-07-21). The relay used to accept
// unlimited share-location events per socket. Two attack modes:
//   1. Buggy client publishes at kHz rates → hider's tab drowned in messages.
//   2. Adversarial join with a guessed session code publishes coords that
//      jitter across the close-approach threshold → Phase 12's once-per-
//      crossing debounce sees fresh outside→inside every ping and fires
//      notification after notification, defeating the debounce entirely.
//
// The token bucket caps sustained rate at 4/s per socket with a 6-token
// burst allowance. Legitimate 60-s Phase-12 cadence is 240x under the limit;
// a flood is silently dropped past the burst.
import test from "node:test";
import assert from "node:assert/strict";
import { allowShareLocation } from "../share-location.js";

test("game 1: burst of 6 within a millisecond — all accepted (the burst allowance)", () => {
  const state = {};
  const now = 1000;
  let accepted = 0;
  for (let i = 0; i < 6; i++) {
    if (allowShareLocation(state, now)) accepted++;
  }
  assert.equal(accepted, 6, "the 6-token burst allowance passes all six");
});

test("game 2: burst of 100 within a millisecond — only 6 accepted, rest silently dropped", () => {
  const state = {};
  const now = 1000;
  let accepted = 0;
  for (let i = 0; i < 100; i++) {
    if (allowShareLocation(state, now)) accepted++;
  }
  assert.equal(accepted, 6, "flood past the burst allowance is dropped");
});

test("game 3: sustained 4/s (250 ms apart) — every ping accepted", () => {
  const state = {};
  let now = 1000;
  let accepted = 0;
  // Consume the burst first, then measure sustained rate.
  for (let i = 0; i < 6; i++) if (allowShareLocation(state, now)) accepted++;
  assert.equal(accepted, 6);
  // Now push exactly at 250 ms cadence for the next 5 s → 20 pings, all pass.
  accepted = 0;
  for (let i = 0; i < 20; i++) {
    now += 250;
    if (allowShareLocation(state, now)) accepted++;
  }
  assert.equal(accepted, 20, "sustained 4/s is exactly the refill rate — all pass");
});

test("game 4: legitimate 60-second cadence — every ping accepted, forever", () => {
  const state = {};
  let now = 1000;
  let accepted = 0;
  for (let i = 0; i < 45; i++) { // simulate a full 45-minute Hide & Seek game
    if (allowShareLocation(state, now)) accepted++;
    now += 60_000;
  }
  assert.equal(accepted, 45, "the real Phase-12 cadence is 240x under the throttle");
});

test("game 5: bucket refills over time — after 1 s of silence, another 4 tokens available", () => {
  const state = {};
  let now = 1000;
  // Burn the burst.
  for (let i = 0; i < 6; i++) allowShareLocation(state, now);
  // Immediately after — nothing.
  assert.equal(allowShareLocation(state, now), false);
  // Wait 1 second → refill of 1000/250 = 4 tokens.
  now += 1000;
  let accepted = 0;
  for (let i = 0; i < 10; i++) if (allowShareLocation(state, now)) accepted++;
  assert.equal(accepted, 4, "one second of silence buys back exactly 4 tokens");
});

test("game 6: independent sockets have independent buckets — one flooder can't starve another seeker", () => {
  const goodSocket = {};
  const floodSocket = {};
  const now = 1000;
  // Flooder drains its own bucket.
  for (let i = 0; i < 100; i++) allowShareLocation(floodSocket, now);
  // The good seeker still has a full bucket.
  let accepted = 0;
  for (let i = 0; i < 6; i++) if (allowShareLocation(goodSocket, now)) accepted++;
  assert.equal(accepted, 6, "per-socket state means a flood on one relay does not affect another");
});

test("game 7: the debounce-defeat attack — 100 jittered pings/s over 10 s produces at most ~40 emissions", () => {
  // This is the actual attack the finding names. Without the rate limit, an
  // attacker publishing 1000 pings jittered across the threshold would fire
  // 1000 outside→inside crossings and 1000 alerts. With the token bucket,
  // most are dropped — a burst of 6 up front + 4/s for the remaining
  // 10 seconds = 6 + 40 = 46 max. Well below 1000.
  const state = {};
  let now = 1000;
  let accepted = 0;
  for (let i = 0; i < 1000; i++) {
    if (allowShareLocation(state, now)) accepted++;
    now += 10; // 100 Hz sustained flood
  }
  assert.ok(accepted <= 46, `expected at most 46 emissions, saw ${accepted}`);
  assert.ok(accepted >= 40, `expected at least 40 emissions over 10 seconds, saw ${accepted}`);
});
