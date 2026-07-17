// Two lines on the SAME rails must not partition against each other.
//
// Named as a known gap when F1 landed ("the seeker can untick one of them"), then measured on a
// real Berlin board (2026-07-17) — and the measurement made it much bigger than the note:
//
//   S5 vs S7    shared 267/282 ways   J=0.95   <- 95% the same physical rails
//   S8 vs S85   shared 150/180 ways   J=0.83
//   S3 vs S5    shared 261/318 ways   J=0.82
//   S3 vs S7    shared 262/324 ways   J=0.81
//
// A hider beside the Stadtbahn trunk is EXACTLY equidistant from S5 and S7 — it is one piece of
// track. They cannot answer "which line are you nearest?", and the old code eliminated the
// other line's cell regardless. Those cells were divided by `dejitter` nudging co-located seeds
// ~0.6 m apart, so the boundary was decided by the nudge DIRECTION: a false elimination
// produced by floating-point noise, silently.
//
// (The note also claimed Berlin's S41/S42 Ring "share rails". Measured: they share ZERO ways —
// OSM maps each direction on its own parallel way. See the last test.)
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea } from "./helpers/turf-env.mjs";
import { lineCells, computeElimination } from "../src/tools.js";
import { groupIntoLines } from "../src/lines.js";
import { normalizeLines } from "../overpass-lines.js";
import { readFileSync } from "node:fs";

const BOARD = squareArea([13.38, 52.5], 0.2); // a Berlin-sized board

// Shared trunk running east-west through the middle, then two divergent branches.
const TRUNK = [[52.50, 13.30], [52.50, 13.40]];
const BRANCH_N = [[52.50, 13.40], [52.55, 13.46]];
const BRANCH_S = [[52.50, 13.40], [52.45, 13.46]];

// Two lines sharing the trunk, diverging at the east end — the S5/S7 shape.
const lineA = { key: "a", label: "S5", paths: [TRUNK, BRANCH_N] };
const lineB = { key: "b", label: "S7", paths: [TRUNK, BRANCH_S] };
// A genuinely separate line, sharing nothing.
const lineC = { key: "c", label: "U8", paths: [[[52.58, 13.30], [52.58, 13.46]]] };

const inside = (geom, lng, lat) =>
  !!geom && turf.booleanPointInPolygon(turf.point([lng, lat]), turf.feature(geom));

test("shared track belongs to BOTH lines — their cells overlap on it", () => {
  const { cells } = lineCells([lineA, lineB], BOARD);
  assert.ok(cells[0] && cells[1], "both lines must get a cell");
  // A point right beside the shared trunk is nearest to both, because they are one track.
  const onTrunk = [13.35, 52.502];
  assert.ok(inside(cells[0], ...onTrunk), "the trunk is in S5's cell");
  assert.ok(inside(cells[1], ...onTrunk), "and in S7's cell — it is the same rails");
});

test("a hider on the shared trunk survives EITHER answer — the false elimination", () => {
  // The bug, stated as the game action that triggers it. The hider is beside the shared trunk
  // and says "S5" (they had to pick something). Nothing about their position distinguishes the
  // two, so the elimination must not remove them — whichever they said.
  const hider = { lng: 13.35, lat: 52.502 };
  const step = (featureIndex) => ({
    id: "t", tool: "tentacles", enabled: true,
    inputs: {
      lines: [lineA, lineB], radius: 20000,
      center: { lng: 13.35, lat: 52.49 }, // seeker just south of the trunk
    },
    answer: { featureIndex },
  });
  for (const [idx, said] of [[0, "S5"], [1, "S7"]]) {
    const { eliminated } = computeElimination(step(idx), BOARD);
    assert.ok(
      !inside(eliminated, hider.lng, hider.lat),
      `the hider is beside track shared by both lines; answering "${said}" must not eliminate them`,
    );
  }
});

test("the DIVERGENT ends still discriminate — the fix is not a blanket merge", () => {
  // This is what a merge-the-lines fix would have thrown away. Where the lines actually
  // separate, the partition is meaningful and must stay sharp.
  const { cells } = lineCells([lineA, lineB], BOARD);
  const nearNorthBranch = [13.45, 52.54];
  const nearSouthBranch = [13.45, 52.46];
  assert.ok(inside(cells[0], ...nearNorthBranch), "the north branch is S5's alone");
  assert.ok(!inside(cells[1], ...nearNorthBranch), "and NOT S7's — they diverge here");
  assert.ok(inside(cells[1], ...nearSouthBranch), "the south branch is S7's alone");
  assert.ok(!inside(cells[0], ...nearSouthBranch), "and NOT S5's");
});

test("lines that share nothing are unaffected — no overlap is introduced", () => {
  // Non-regression: the overlap must come from shared coordinates, never from the mechanism.
  const { cells } = lineCells([lineA, lineC], BOARD);
  const onC = [13.38, 52.58];
  assert.ok(inside(cells[1], ...onC), "U8's own track is in U8's cell");
  assert.ok(!inside(cells[0], ...onC), "and not in S5's — these lines share no track");
});

test("the cells still cover the board — overlap must not leave holes", () => {
  const { cells } = lineCells([lineA, lineB, lineC], BOARD);
  const union = cells.filter(Boolean).reduce((acc, c) =>
    acc ? turf.union(turf.featureCollection([turf.feature(acc), turf.feature(c)])).geometry : c, null);
  const covered = turf.area(turf.feature(union)) / turf.area(turf.feature(BOARD));
  assert.ok(covered > 0.99, `every point is nearest to something; covered ${(covered * 100).toFixed(1)}%`);
});

test("REAL Berlin S5/S7: a hider on the Stadtbahn trunk is in both cells", () => {
  // The synthetic trunk above is the mechanism; this is the actual board that motivated it.
  // A real capture is worth the 265 KB — real data has repeatedly carried structure the
  // synthetic case didn't (DC's Capitol people-movers, Mumbai's under-construction HSR).
  const json = JSON.parse(readFileSync(new URL("./fixtures/overpass-metro-berlin-s5-s7.json", import.meta.url), "utf8"));
  const groups = groupIntoLines(normalizeLines("metro", json));
  const byLabel = Object.fromEntries(groups.map((g) => [g.label, g]));
  const S5 = byLabel["S5"], S7 = byLabel["S7"];
  assert.ok(S5 && S7, "the capture must group into exactly the two lines");

  const s7Ways = new Set(S7.wayIds);
  const shared = S5.wayIds.filter((id) => s7Ways.has(id));
  assert.ok(shared.length > 200, `S5/S7 share most of their track on this board (${shared.length} ways)`);

  const BERLIN = { type: "Polygon", coordinates: [[[13.28, 52.45], [13.48, 52.45], [13.48, 52.56], [13.28, 52.56], [13.28, 52.45]]] };
  const { cells } = lineCells([S5, S7], BERLIN);

  // A point taken from the middle of a way BOTH lines actually run over.
  const sharedSet = new Set(shared);
  const way = json.elements.find((e) => e.type === "way" && sharedSet.has(e.id) && e.geometry?.length);
  const p = way.geometry[Math.floor(way.geometry.length / 2)];
  assert.ok(inside(cells[0], p.lon, p.lat), "a hider on the shared trunk is in S5's cell");
  assert.ok(inside(cells[1], p.lon, p.lat), "and in S7's cell — so either answer keeps them");
});

test("a union failure is LOUD, not a silently truncated cell", () => {
  // Found while merging the cells once instead of folding them pairwise. The old fold read
  // `cells[idx] = cells[idx] ? safeUnion(cells[idx], clip) : clip`, and safeUnion swallows its
  // exception and returns null — so one failure mid-fold left cells[idx] null, and the NEXT
  // iteration took the falsy branch and restarted from that single cell. Everything gathered
  // so far vanished; the line's region came out a fragment; the elimination removed too much;
  // nothing threw. An A7-shaped bug hiding one level down, in lineCells' own internals.
  //
  // A smaller cell eliminates MORE, so this failure direction is a false elimination — it has
  // to be loud, exactly like the voronoi failure beside it.
  const realUnion = window.turf.union;
  window.turf.union = () => { throw new Error("simulated union failure"); };
  try {
    assert.throws(
      () => lineCells([lineA, lineB], BOARD),
      /Nearest-line partition failed merging/,
      "a failed merge must throw, not hand back a truncated region",
    );
  } finally {
    window.turf.union = realUnion;
  }
});

test("the S41/S42 note was wrong: parallel tracks share no coordinates", () => {
  // Recorded because the original note said the Ring lines "share rails". They do not — OSM
  // maps each direction on its own way, ~10 m apart. So coordinate-sharing does NOT merge them,
  // and it should not: at 10 m apart they are still two distinct tracks. This test pins the
  // limit of the fix rather than pretending it covers everything.
  const ringClockwise = { key: "s41", label: "S41", paths: [[[52.50, 13.30], [52.50, 13.40]]] };
  const ringAnti = { key: "s42", label: "S42", paths: [[[52.5001, 13.30], [52.5001, 13.40]]] }; // ~11 m north
  const { cells } = lineCells([ringClockwise, ringAnti], BOARD);
  assert.ok(cells[0] && cells[1], "both still get cells");
  // They are ~11 m apart, so the partition between them is a line down the middle of the
  // corridor: geometrically well-defined, humanly meaningless. Out of scope here, and NOT
  // silently wrong the way shared track was — a point really is nearer one of them.
  const wellNorth = [13.35, 52.55];
  assert.ok(inside(cells[1], ...wellNorth), "north of both is nearest the northern track");
  assert.ok(!inside(cells[0], ...wellNorth), "so the cells are still disjoint here");
});
