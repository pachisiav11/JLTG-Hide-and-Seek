// Phase 40 (Stage 6): the Doze-spike verdict logic.
//
// The spike itself needs a phone, but its CONCLUSION is a pure reduction over a
// fix log — and that reduction is what makes the on-device test conclusive
// rather than a vibe. These tests pin the reduction: a normal steady run PASSES,
// a run with one Doze-sized gap FAILS, and the edge cases (no fixes, too few,
// missing timestamps) resolve to an honest "can't tell yet" rather than a false
// pass. If this logic drifts, the spike could green-light a plugin that actually
// dies in Doze — the exact failure the whole native track is trying to avoid.
import test from "node:test";
import assert from "node:assert/strict";

const {
  normalizeLocation,
  fixGapMs,
  spikeZoneFromFix,
  summarizeSpikeLog,
  spikeVerdict,
} = await import("../src/bg-spike.js");

test("normalizeLocation accepts both plugin and getCurrentPosition shapes", () => {
  // Community plugin shape: latitude/longitude/time.
  const a = normalizeLocation({ latitude: 1.5, longitude: 103.8, accuracy: 12, time: 1000 });
  assert.deepEqual(a, { lat: 1.5, lng: 103.8, accuracy: 12, at: 1000 });
  // Our own {lat,lng} shape, no time → stamped with now (finite, recent).
  const before = Date.now();
  const b = normalizeLocation({ lat: 2, lng: 3 });
  assert.equal(b.lat, 2);
  assert.equal(b.accuracy, null);
  assert.ok(b.at >= before);
});

test("normalizeLocation rejects a fix with no finite coordinates", () => {
  assert.equal(normalizeLocation(null), null);
  assert.equal(normalizeLocation({ accuracy: 5 }), null);
  assert.equal(normalizeLocation({ latitude: NaN, longitude: 4 }), null);
});

test("fixGapMs is the non-negative delta, or null when a timestamp is missing", () => {
  assert.equal(fixGapMs({ at: 1000 }, { at: 4000 }), 3000);
  assert.equal(fixGapMs({ at: 5000 }, { at: 4000 }), 0); // out-of-order clamps to 0
  assert.equal(fixGapMs(null, { at: 1 }), null);
  assert.equal(fixGapMs({ at: 0 }, { at: 1000 }), null); // at must be > 0
});

test("spikeZoneFromFix builds a {point,radius} zone, null on a bad fix", () => {
  assert.deepEqual(spikeZoneFromFix({ lat: 1, lng: 2 }, { radius: 200 }), { point: { lat: 1, lng: 2 }, radius: 200 });
  assert.equal(spikeZoneFromFix(null), null);
  assert.equal(spikeZoneFromFix({ lat: NaN, lng: 2 }), null);
});

// Build a steady run of `n` fixes spaced `stepMs` apart from t0.
function steadyRun(n, stepMs, t0 = 1_000_000) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ type: "fix", lat: 1 + i * 1e-4, lng: 2, accuracy: 8, at: t0 + i * stepMs });
  return rows;
}

test("summarizeSpikeLog reports fix count, notif count, and gap stats", () => {
  const rows = steadyRun(4, 30_000);
  rows.splice(2, 0, { type: "notify", title: "x", body: "y", at: 1 }); // an interleaved notify
  const s = summarizeSpikeLog(rows);
  assert.equal(s.fixCount, 4);
  assert.equal(s.notifyCount, 1);
  assert.equal(s.medianGapMs, 30_000);
  assert.equal(s.maxGapMs, 30_000);
  assert.equal(s.firstAt, 1_000_000);
  assert.equal(s.lastAt, 1_000_000 + 3 * 30_000);
});

test("VERDICT: a steady 30 s run through the window PASSES", () => {
  // 20 fixes at the requested 30 s cadence = a plugin that stayed alive.
  const s = summarizeSpikeLog(steadyRun(20, 30_000));
  const v = spikeVerdict(s, { expectedIntervalMs: 30_000 });
  assert.equal(v.pass, true, v.reason);
  assert.match(v.reason, /SURVIVED/);
});

test("VERDICT: one Doze-sized gap FAILS even with many good fixes", () => {
  // Steady for a while, then a 10-minute hole (plugin parked in Doze), then resumes.
  const rows = steadyRun(10, 30_000);
  const lastAt = rows[rows.length - 1].at;
  rows.push({ type: "fix", lat: 5, lng: 2, accuracy: 8, at: lastAt + 10 * 60_000 });
  for (let i = 1; i <= 5; i++) rows.push({ type: "fix", lat: 5, lng: 2, accuracy: 8, at: lastAt + 10 * 60_000 + i * 30_000 });
  const v = spikeVerdict(summarizeSpikeLog(rows), { expectedIntervalMs: 30_000 });
  assert.equal(v.pass, false, "a 10-minute gap must fail the spike");
  assert.match(v.reason, /SUSPENDED|Doze/);
});

test("VERDICT: honest 'can't tell' on no / too few fixes", () => {
  const none = spikeVerdict(summarizeSpikeLog([]), {});
  assert.equal(none.pass, false);
  assert.match(none.reason, /No fixes/);
  const few = spikeVerdict(summarizeSpikeLog(steadyRun(2, 30_000)), {});
  assert.equal(few.pass, false);
  assert.match(few.reason, /too few/i);
});

test("VERDICT: tolerance is configurable — a 3x gap passes at 4x, fails at 2x", () => {
  const rows = steadyRun(5, 30_000);
  const lastAt = rows[rows.length - 1].at;
  rows.push({ type: "fix", lat: 9, lng: 2, accuracy: 8, at: lastAt + 90_000 }); // a 90 s gap = 3x
  const s = summarizeSpikeLog(rows);
  assert.equal(spikeVerdict(s, { expectedIntervalMs: 30_000, tolerance: 4 }).pass, true);
  assert.equal(spikeVerdict(s, { expectedIntervalMs: 30_000, tolerance: 2 }).pass, false);
});
