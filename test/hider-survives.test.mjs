// v2 Phase 1, item C — the property the whole app rests on.
//
// Every question the seeker asks removes ground. The one thing that must never happen is
// removing the ground the hider is ACTUALLY standing on: an under-elimination costs a turn,
// a false elimination loses the game outright and does it invisibly — the map looks healthy,
// the shading looks confident, and the answer is simply not in it any more.
//
// Nothing asserted this before. Every existing test checks a tool in isolation ("does radar
// remove the right circle?"); none checks the composite claim that a board of TRUTHFULLY
// answered questions still contains the truth. Those are different properties, and it is the
// second one a seeker actually relies on.
//
// Method: put a hider at a known point, let test/oracle.js derive the answer a truthful hider
// would give to each question, fold the board, assert the hider is still inside the surviving
// area. The oracle is the interesting half — it is written from the GAME's semantics ("hotter
// means closer to B"), independently of how tools.js builds its polygons, so agreement between
// them is real evidence rather than a tautology.
//
// The grid tests matter more than the single-point ones: a bug that loses the hider only in a
// thin band near a boundary passes any hand-picked point and fails a sweep.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import { verifyHiderRetained, truthfulAnswer } from "./oracle.js";
import { computeActiveArea } from "../src/tools.js";

const CENTRE = [72.8777, 19.076]; // Mumbai, matching the rest of the suite
const BOARD = () => squareArea(CENTRE, 0.4);

// Interior sample points. The board is 0.4° on a side; 0.16 keeps every point well inside
// so a retained/eliminated verdict is never decided by the board edge itself.
function* interiorGrid(n = 7, span = 0.16) {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      yield {
        lng: CENTRE[0] - span + (2 * span * i) / (n - 1),
        lat: CENTRE[1] - span + (2 * span * j) / (n - 1),
      };
    }
  }
}

// Candidate POIs scattered across the board, deterministic so a failure is reproducible.
function pois(n = 6) {
  const out = [];
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < n; i++) {
    out.push({
      name: `P${i}`,
      lng: CENTRE[0] - 0.15 + rnd() * 0.3,
      lat: CENTRE[1] - 0.15 + rnd() * 0.3,
      len: 3 + (i % 4), // for the nameLength card
    });
  }
  return out;
}

// A step's `answer` is whatever the seeker recorded; the oracle overwrites it with the truth.
// The seeker-chosen fields (which candidate they picked, their own distance) must survive that,
// so they are seeded here as a real seeker would have left them.
const steps = {
  radar: (id, center, radiusM) => ({
    id, tool: "radar", enabled: true,
    inputs: { center: { lng: center[0], lat: center[1] }, radius: radiusM },
    answer: { side: "in" },
  }),
  thermometer: (id, a, b) => ({
    id, tool: "thermometer", enabled: true,
    inputs: { a: { lng: a[0], lat: a[1] }, b: { lng: b[0], lat: b[1] } },
    answer: { side: "hotter" },
  }),
  matchingNearest: (id, features, seekerIdx) => ({
    id, tool: "matching", enabled: true,
    inputs: { mode: "nearest", features },
    answer: { featureIndex: seekerIdx, keep: true },
  }),
  matchingNameLength: (id, features, seekerLen) => ({
    id, tool: "matching", enabled: true,
    inputs: { mode: "nameLength", features },
    answer: { length: seekerLen, match: true },
  }),
  matchingRegion: (id, ring) => ({
    id, tool: "matching", enabled: true,
    inputs: { mode: "region", ring },
    answer: { inside: true },
  }),
  tentacles: (id, features, center, radiusM) => ({
    id, tool: "tentacles", enabled: true,
    inputs: { features, center: { lng: center[0], lat: center[1] }, radius: radiusM },
    answer: { featureIndex: 0 },
  }),
  measuring: (id, refGeometry, distanceM) => ({
    id, tool: "measuring", enabled: true,
    inputs: { refType: "points", refGeometry, distance: distanceM },
    answer: { side: "in" },
  }),
};

// A [lat,lng] ring — the axis order regions are stored in.
const ringAround = (lng, lat, h) => [
  [lat - h, lng - h], [lat - h, lng + h], [lat + h, lng + h], [lat + h, lng - h], [lat - h, lng - h],
];

function assertAllRetained(board, history, label) {
  const lost = [];
  for (const hider of interiorGrid()) {
    const r = verifyHiderRetained(board, history, hider);
    if (!r.retained) lost.push({ hider, reason: r.reason, skipped: r.skipped });
  }
  assert.equal(
    lost.length, 0,
    `${label}: ${lost.length} truthfully-answered position(s) were eliminated. First: ${JSON.stringify(lost[0])}`,
  );
}

test("radar retains the hider from every position on the board", () => {
  const board = BOARD();
  // Several radii, including ones whose circle sits partly off the board.
  for (const radiusM of [3000, 9000, 18000, 40000]) {
    assertAllRetained(board, [steps.radar("r", CENTRE, radiusM)], `radar r=${radiusM}`);
  }
});

test("thermometer retains the hider from every position on the board", () => {
  const board = BOARD();
  const pairs = [
    [[72.80, 19.02], [72.95, 19.13]],
    [[72.95, 19.02], [72.80, 19.13]],
    [[72.8777, 18.95], [72.8777, 19.20]], // due north — a pure-latitude bisector
    [[72.75, 19.076], [73.00, 19.076]],   // due east — a pure-longitude bisector
  ];
  for (const [a, b] of pairs) {
    assertAllRetained(board, [steps.thermometer("t", a, b)], `thermometer ${JSON.stringify([a, b])}`);
  }
});

test("matching (nearest) retains the hider whichever candidate the seeker picked", () => {
  const board = BOARD();
  const features = pois(6);
  for (let seekerIdx = 0; seekerIdx < features.length; seekerIdx++) {
    assertAllRetained(board, [steps.matchingNearest("m", features, seekerIdx)], `matching nearest idx=${seekerIdx}`);
  }
});

test("matching (name length) retains the hider for every seeker length", () => {
  const board = BOARD();
  const features = pois(8);
  for (const len of [3, 4, 5, 6]) {
    assertAllRetained(board, [steps.matchingNameLength("n", features, len)], `nameLength len=${len}`);
  }
});

test("matching (region) retains the hider inside and outside the drawn region", () => {
  const board = BOARD();
  const ring = ringAround(CENTRE[0], CENTRE[1], 0.08);
  assertAllRetained(board, [steps.matchingRegion("g", ring)], "matching region");
});

test("tentacles retains the hider, including every miss outside the seeker's reach", () => {
  const board = BOARD();
  const features = pois(5);
  for (const radiusM of [4000, 12000, 25000]) {
    assertAllRetained(board, [steps.tentacles("tt", features, CENTRE, radiusM)], `tentacles R=${radiusM}`);
  }
});

test("measuring retains the hider on both sides of the buffer", () => {
  const board = BOARD();
  const ref = {
    type: "MultiPoint",
    coordinates: pois(4).map((f) => [f.lng, f.lat]),
  };
  for (const distanceM of [2000, 8000, 20000]) {
    assertAllRetained(board, [steps.measuring("ms", ref, distanceM)], `measuring d=${distanceM}`);
  }
});

test("measuring against a LINE reference retains the hider on both sides", () => {
  const board = BOARD();
  // A diagonal reference line crossing the board, as a sourced coastline would be.
  const ref = {
    type: "LineString",
    coordinates: [[72.78, 18.98], [72.86, 19.06], [72.94, 19.10], [72.99, 19.17]],
  };
  for (const distanceM of [1500, 6000, 15000]) {
    assertAllRetained(board, [steps.measuring("ml", ref, distanceM)], `measuring line d=${distanceM}`);
  }
});

// The composite claim. Any single tool being right does not imply the fold is: eliminations
// are unioned, and a union is exactly where an off-by-one side flips into removing the truth.
test("a full seven-question board retains the hider from every position", () => {
  const board = BOARD();
  const features = pois(6);
  const history = [
    steps.radar("r1", CENTRE, 22000),
    steps.radar("r2", [72.83, 19.03], 30000),
    steps.thermometer("t1", [72.80, 19.02], [72.95, 19.13]),
    steps.matchingNearest("m1", features, 2),
    steps.matchingNameLength("n1", pois(8), 4),
    steps.matchingRegion("g1", ringAround(CENTRE[0], CENTRE[1], 0.1)),
    steps.measuring("ms1", { type: "MultiPoint", coordinates: features.map((f) => [f.lng, f.lat]) }, 9000),
  ];
  assertAllRetained(board, history, "seven-question board");
});

// A board that narrows hard is the interesting case: the more it eliminates, the more chances
// it has to eliminate the wrong thing. This asserts BOTH that the hider survives and that the
// board actually did meaningful work — a fold that eliminates nothing would pass vacuously.
test("a narrowing board still retains the hider, and genuinely narrows", () => {
  const board = BOARD();
  const boardKm2 = turf.area(turf.feature(board)) / 1e6;
  const features = pois(6);
  const hider = { lng: 72.9, lat: 19.1 };

  const history = [
    steps.radar("r1", CENTRE, 20000),
    steps.thermometer("t1", [72.80, 19.02], [72.95, 19.13]),
    steps.matchingNearest("m1", features, 1),
    steps.measuring("ms1", { type: "MultiPoint", coordinates: features.map((f) => [f.lng, f.lat]) }, 6000),
  ];

  const r = verifyHiderRetained(board, history, hider);
  assert.ok(r.retained, `the hider must survive a narrowing board (reason: ${r.reason})`);
  assert.equal(r.skipped.length, 0, "every question in this board must be answerable by the oracle");

  const activeKm2 = turf.area(turf.feature(r.active)) / 1e6;
  assert.ok(activeKm2 < boardKm2 * 0.5,
    `the board must actually narrow — got ${activeKm2.toFixed(1)} of ${boardKm2.toFixed(1)} km²`);
});

// Guard the harness itself. If the oracle silently returned null for everything, every test
// above would pass while checking nothing — the failure mode that makes a green suite worthless.
test("the oracle answers every tool it claims to (no silent skips)", () => {
  const board = BOARD();
  const features = pois(4);
  const hider = { lng: 72.89, lat: 19.09 };
  const cases = [
    steps.radar("r", CENTRE, 10000),
    steps.thermometer("t", [72.80, 19.02], [72.95, 19.13]),
    steps.matchingNearest("m", features, 0),
    steps.matchingNameLength("n", features, 4),
    steps.matchingRegion("g", ringAround(CENTRE[0], CENTRE[1], 0.08)),
    steps.tentacles("tt", features, CENTRE, 12000),
    steps.measuring("ms", { type: "MultiPoint", coordinates: features.map((f) => [f.lng, f.lat]) }, 5000),
  ];
  for (const s of cases) {
    const a = truthfulAnswer(s, hider, board);
    assert.ok(a && typeof a === "object", `${s.tool}/${s.inputs.mode || ""} must produce an answer`);
  }
});

// A deliberately WRONG answer must be caught. Without this, "retained" could be a constant.
test("the harness detects a false elimination when the answer is inverted", () => {
  const board = BOARD();
  const hider = { lng: 72.95, lat: 19.13 };
  // The hider is ~8 km from the centre; a 3 km radar truthfully answers "out". Recording
  // "in" instead eliminates everything outside the circle — including the hider.
  const lying = { ...steps.radar("r", CENTRE, 3000), answer: { side: "in" } };
  const active = turf.feature(computeActiveArea(board, [lying]));
  assert.equal(
    turf.booleanPointInPolygon(turf.point([hider.lng, hider.lat]), active), false,
    "sanity: a wrong answer really does eliminate the hider, so the check above can fail",
  );
});
