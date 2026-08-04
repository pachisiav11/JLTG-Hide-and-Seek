// v2 Phase 1, item B — the two answers to a question must partition the board.
//
// For any binary question, the region kept by "yes" and the region kept by "no" must
// together be the whole board, and must not overlap:
//
//     area(kept_yes) + area(kept_no) == area(board)      (no gap)
//     area(kept_yes ∩ kept_no)       == 0                (no overlap)
//
// This is one property, but it catches an entire family of bugs that unit tests miss:
// an inverted side, a `keep` read as `keep !== false` on one branch and `keep === true`
// on the other, a buffer clipped against the wrong operand, a difference where an
// intersect belonged. Every one of those shows up as a gap or an overlap.
//
// A GAP is the dangerous direction: ground that neither answer keeps is ground the hider
// can never be in, whatever they say — so the board silently rules out a position that no
// question actually excluded. An OVERLAP is merely wasteful (the question eliminates less
// than it could), but it also means the two branches disagree about the boundary, which is
// usually the same bug seen from the other side.
//
// This is exactly the check that produced confidence in the reference mapper
// (MAPPER_ANALYSIS §2.1), where all four sampled questions summed to the board exactly.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import { computeElimination } from "../src/tools.js";

const CENTRE = [72.8777, 19.076];
const BOARD = () => squareArea(CENTRE, 0.4);
const km2 = (g) => (g ? turf.area(turf.feature(g)) / 1e6 : 0);

// The region a step KEEPS = board minus what it eliminates. `eliminated: null` means the
// step rules nothing out, so it keeps everything.
function keptFor(step, board) {
  const { eliminated } = computeElimination(step, board);
  if (!eliminated) return board;
  const d = turf.difference(turf.featureCollection([turf.feature(board), turf.feature(eliminated)]));
  return d ? d.geometry : null;
}

function overlapKm2(a, b) {
  if (!a || !b) return 0;
  try {
    const i = turf.intersect(turf.featureCollection([turf.feature(a), turf.feature(b)]));
    return i ? turf.area(i) / 1e6 : 0;
  } catch { return 0; }
}

// Geometry ops on circles and buffers are polygonised, so exact equality is the wrong
// assertion. 0.1% of the board is far tighter than any real bug (an inverted side is a
// ~50% error) and far looser than polygonisation noise.
const TOL = 0.001;

function assertPartitions(board, variants, label) {
  const boardKm2 = km2(board);
  const kept = variants.map(({ step }) => keptFor(step, board));
  const total = kept.reduce((s, k) => s + km2(k), 0);

  assert.ok(
    Math.abs(total - boardKm2) <= boardKm2 * TOL,
    `${label}: answers must cover the board exactly — kept ${total.toFixed(3)} of ${boardKm2.toFixed(3)} km² ` +
    `(${((total - boardKm2) / boardKm2 * 100).toFixed(3)}% ${total < boardKm2 ? "GAP" : "OVERLAP"})`,
  );

  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const ov = overlapKm2(kept[i], kept[j]);
      assert.ok(
        ov <= boardKm2 * TOL,
        `${label}: "${variants[i].name}" and "${variants[j].name}" must not overlap — ${ov.toFixed(3)} km² shared`,
      );
    }
  }

  // A question whose branches are all empty, or all the whole board, would satisfy the sum
  // trivially. Require that each branch is a real subset — otherwise this test is vacuous.
  kept.forEach((k, i) => {
    const a = km2(k);
    assert.ok(a > 0, `${label}: "${variants[i].name}" keeps nothing at all — the question is degenerate`);
    assert.ok(a < boardKm2 * 0.999, `${label}: "${variants[i].name}" keeps the whole board — it eliminates nothing`);
  });
}

const sides = (make, a, b) => [
  { name: a, step: make(a) },
  { name: b, step: make(b) },
];

test("radar: in / out partition the board", () => {
  const board = BOARD();
  for (const radiusM of [3000, 9000, 20000]) {
    const make = (side) => ({
      id: "r", tool: "radar", enabled: true,
      inputs: { center: { lng: CENTRE[0], lat: CENTRE[1] }, radius: radiusM },
      answer: { side },
    });
    assertPartitions(board, sides(make, "in", "out"), `radar r=${radiusM}`);
  }
});

test("thermometer: hotter / colder partition the board", () => {
  const board = BOARD();
  const pairs = [
    [[72.80, 19.02], [72.95, 19.13]],
    [[72.8777, 18.98], [72.8777, 19.18]],
    [[72.78, 19.076], [72.98, 19.076]],
  ];
  for (const [a, b] of pairs) {
    const make = (side) => ({
      id: "t", tool: "thermometer", enabled: true,
      inputs: { a: { lng: a[0], lat: a[1] }, b: { lng: b[0], lat: b[1] } },
      answer: { side },
    });
    assertPartitions(board, sides(make, "hotter", "colder"), `thermometer ${JSON.stringify([a, b])}`);
  }
});

// `spreadDeg` is the half-width the candidates are scattered over. It matters for
// tentacles: the card searches within its own radius of the seeker, so every candidate the
// app ever puts in the list is inside the reach. Scattering them wider than the reach builds
// a board the UI cannot produce, where a candidate's cell need not touch the seeker circle
// at all — see the impossible-answer test at the bottom of this file.
const features = (n, spreadDeg = 0.15) => {
  const out = [];
  let s = 9876;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < n; i++) {
    out.push({
      name: `P${i}`,
      lng: CENTRE[0] - spreadDeg + rnd() * 2 * spreadDeg,
      lat: CENTRE[1] - spreadDeg + rnd() * 2 * spreadDeg,
      len: 3 + (i % 3),
    });
  }
  return out;
};

// Degrees of latitude for a given ground distance — used to keep tentacle candidates
// inside the card's reach, the way the real search does.
const metresToDeg = (m) => m / 111320;

test("matching (nearest): same / different partition the board", () => {
  const board = BOARD();
  const fs = features(5);
  for (let idx = 0; idx < fs.length; idx++) {
    const make = (keep) => ({
      id: "m", tool: "matching", enabled: true,
      inputs: { mode: "nearest", features: fs },
      answer: { featureIndex: idx, keep },
    });
    assertPartitions(board, [
      { name: "same", step: make(true) },
      { name: "different", step: make(false) },
    ], `matching nearest idx=${idx}`);
  }
});

test("matching (name length): match / no-match partition the board", () => {
  const board = BOARD();
  const fs = features(9);
  for (const len of [3, 4, 5]) {
    const make = (match) => ({
      id: "n", tool: "matching", enabled: true,
      inputs: { mode: "nameLength", features: fs },
      answer: { length: len, match },
    });
    assertPartitions(board, [
      { name: "match", step: make(true) },
      { name: "no-match", step: make(false) },
    ], `nameLength len=${len}`);
  }
});

test("matching (region): inside / outside partition the board", () => {
  const board = BOARD();
  const h = 0.09;
  const ring = [
    [CENTRE[1] - h, CENTRE[0] - h], [CENTRE[1] - h, CENTRE[0] + h],
    [CENTRE[1] + h, CENTRE[0] + h], [CENTRE[1] + h, CENTRE[0] - h],
    [CENTRE[1] - h, CENTRE[0] - h],
  ];
  const make = (inside) => ({
    id: "g", tool: "matching", enabled: true,
    inputs: { mode: "region", ring },
    answer: { inside },
  });
  assertPartitions(board, [
    { name: "inside", step: make(true) },
    { name: "outside", step: make(false) },
  ], "matching region");
});

test("measuring: within / beyond partition the board", () => {
  const board = BOARD();
  const ref = { type: "MultiPoint", coordinates: features(4).map((f) => [f.lng, f.lat]) };
  for (const distance of [2000, 8000, 18000]) {
    const make = (side) => ({
      id: "ms", tool: "measuring", enabled: true,
      inputs: { refType: "points", refGeometry: ref, distance },
      answer: { side },
    });
    assertPartitions(board, sides(make, "in", "out"), `measuring d=${distance}`);
  }
});

test("measuring against a line: within / beyond partition the board", () => {
  const board = BOARD();
  const ref = { type: "LineString", coordinates: [[72.78, 18.98], [72.86, 19.06], [72.94, 19.10], [72.99, 19.17]] };
  for (const distance of [1500, 6000, 14000]) {
    const make = (side) => ({
      id: "ml", tool: "measuring", enabled: true,
      inputs: { refType: "line", refGeometry: ref, distance },
      answer: { side },
    });
    assertPartitions(board, sides(make, "in", "out"), `measuring line d=${distance}`);
  }
});

// Tentacles is not binary: its answers are {closest to each candidate} ∪ {miss}. The same
// invariant applies across that whole answer set, which is a stronger claim than any pair.
test("tentacles (points): every candidate plus the miss partition the board", () => {
  const board = BOARD();
  for (const radius of [6000, 15000, 30000]) {
    // Candidates inside the reach, as the card's own search guarantees (layers.js filters
    // `distance <= cat.radius` before offering them). 0.6 of the radius keeps them clear of
    // the circle edge so the partition is exercised in its interior, not at a tangency.
    const fs = features(5, metresToDeg(radius) * 0.6);
    const variants = fs.map((f, i) => ({
      name: `closest to ${f.name}`,
      step: {
        id: "tt", tool: "tentacles", enabled: true,
        inputs: { features: fs, center: { lng: CENTRE[0], lat: CENTRE[1] }, radius },
        answer: { featureIndex: i },
      },
    }));
    variants.push({
      name: "miss",
      step: {
        id: "tt", tool: "tentacles", enabled: true,
        inputs: { features: fs, center: { lng: CENTRE[0], lat: CENTRE[1] }, radius },
        answer: { none: true },
      },
    });
    assertPartitions(board, variants, `tentacles R=${radius}`);
  }
});

// Nearest-LINE cells deliberately OVERLAP where lines share physical track (see the long
// note above `lineCells`): a hider beside shared rails is genuinely equidistant, so both
// lines' cells must contain them. That breaks the no-overlap half of the invariant on
// purpose, and the direction is the safe one — overlapping cells eliminate strictly less.
//
// So the claim for lines is COVERAGE, not partition: the answers must still leave no gap.
// Asserting that separately is the point — it pins the intended asymmetry, so a future
// change that quietly made line cells disjoint again would fail here rather than silently
// reintroduce the false eliminations that overlap exists to prevent.
test("tentacles (lines): shared track overlaps, but the answers still leave no gap", () => {
  const board = BOARD();
  // Two lines sharing a trunk, then diverging — the Berlin S5/S7 shape in miniature.
  const trunk = [[19.04, 72.82], [19.06, 72.86], [19.08, 72.90]];
  const lines = [
    { id: "A", paths: [[...trunk, [19.10, 72.94], [19.12, 72.98]]] },
    { id: "B", paths: [[...trunk, [19.10, 72.93], [19.11, 72.86]]] },
  ];
  const radius = 30000;
  const variants = lines.map((ln, i) => ({
    name: `nearest ${ln.id}`,
    step: {
      id: "tl", tool: "tentacles", enabled: true,
      inputs: { lines, center: { lng: CENTRE[0], lat: CENTRE[1] }, radius },
      answer: { featureIndex: i },
    },
  }));
  variants.push({
    name: "miss",
    step: {
      id: "tl", tool: "tentacles", enabled: true,
      inputs: { lines, center: { lng: CENTRE[0], lat: CENTRE[1] }, radius },
      answer: { none: true },
    },
  });

  const boardKm2 = km2(board);
  const kept = variants.map((v) => keptFor(v.step, board));
  const union = kept.reduce((acc, k) => {
    if (!k) return acc;
    if (!acc) return k;
    const u = turf.union(turf.featureCollection([turf.feature(acc), turf.feature(k)]));
    return u ? u.geometry : acc;
  }, null);

  assert.ok(union, "the line answers must keep something");
  const covered = km2(union);
  assert.ok(
    covered >= boardKm2 * (1 - TOL),
    `line answers must leave no gap — covered ${covered.toFixed(3)} of ${boardKm2.toFixed(3)} km²`,
  );

  // And the overlap must be real, not incidental: this is the shared-track guarantee.
  const shared = overlapKm2(kept[0], kept[1]);
  assert.ok(shared > 0, "cells for lines sharing track must overlap — that is what keeps an equidistant hider");
});

// The configuration the invariant test above deliberately avoids: a candidate so far outside
// the seeker's reach that its Voronoi cell never touches the seeker circle. "I am within 6 km
// of you AND closest to that thing 16 km away" describes no point on the board.
//
// This used to return `eliminated: null` — indistinguishable from a question that legitimately
// rules nothing out, so the step sat in the list looking answered and contributed no shading
// with nothing to indicate it. It now throws, which routes it to the same "⚠ failed" badge a
// degenerate partition gets. Under-eliminating is still the right conservative behaviour; the
// change is that it is no longer silent.
test("tentacles: an impossible answer fails loudly instead of silently eliminating nothing", () => {
  const board = BOARD();
  const radius = 4000;
  // Candidates spread far wider than the reach; index 0 is the far one.
  const fs = [
    { name: "far", lng: CENTRE[0] + 0.16, lat: CENTRE[1] + 0.16 },
    { name: "near", lng: CENTRE[0] + 0.002, lat: CENTRE[1] + 0.002 },
  ];
  const step = {
    id: "tt", tool: "tentacles", enabled: true,
    inputs: { features: fs, center: { lng: CENTRE[0], lat: CENTRE[1] }, radius },
    answer: { featureIndex: 0 },
  };
  assert.throws(
    () => computeElimination(step, board),
    /impossible on this board/,
    "an answer no point can satisfy must surface, not pass as a no-op",
  );
});

// The same board with the reachable candidate answered must still work — the throw above
// must be about the impossible answer, not about the candidate list being wide.
test("tentacles: a reachable candidate on the same wide list still computes", () => {
  const board = BOARD();
  const fs = [
    { name: "far", lng: CENTRE[0] + 0.16, lat: CENTRE[1] + 0.16 },
    { name: "near", lng: CENTRE[0] + 0.002, lat: CENTRE[1] + 0.002 },
  ];
  const step = {
    id: "tt", tool: "tentacles", enabled: true,
    inputs: { features: fs, center: { lng: CENTRE[0], lat: CENTRE[1] }, radius: 4000 },
    answer: { featureIndex: 1 },
  };
  const { eliminated } = computeElimination(step, board);
  assert.ok(eliminated, "the reachable candidate must still produce an elimination");
  const kept = keptFor(step, board);
  assert.ok(km2(kept) > 0 && km2(kept) < km2(board), "and must keep a real share of the board");
});
