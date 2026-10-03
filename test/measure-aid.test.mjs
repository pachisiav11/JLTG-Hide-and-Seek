// The hider's measure aid — and the walls around it.
//
// It is a deliberate, scoped exception to "the companion never answers its own questions"
// (GUIDE.md §6.1), made by the players after Playtest 2. The exception is only acceptable while
// it stays inside its walls, so this file tests the walls as hard as the arithmetic:
//
//   1. it MEASURES correctly (distances to places, lines, region edges, the seekers' centre);
//   2. it returns MEASUREMENTS ONLY — no field that is, or could be read as, the answer;
//   3. it is reachable only from the hider's received-reference view, never from a seeker flow,
//      the elimination engine, or anything that writes a step;
//   4. the received-reference view never writes a question.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { measureAgainstRef } from "../src/measure-aid.js";
import { parseQuestionRef, questionRefText, buildQuestionRef } from "../src/question-ref.js";

const SRC = new URL("../src/", import.meta.url).pathname;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ~111 m per 0.001° of latitude.
const HERE = { lat: 19.0, lng: 72.8 };
const refOf = (tool, inputs, seeker = {}) => parseQuestionRef(questionRefText(buildQuestionRef({ tool, inputs, seeker })));

test("places: every listed place measured and ranked nearest-first, numbering kept", () => {
  const ref = refOf("matching", { mode: "nearest", category: "museum", categoryLabel: "Museum", features: [
    { lat: 19.010, lng: 72.8, name: "Far" }, { lat: 19.001, lng: 72.8, name: "Near" }, { lat: 19.005, lng: 72.8, name: "Mid" },
  ] }, { nearest: 1 });
  const m = measureAgainstRef(ref, HERE);
  assert.deepEqual(m.pois.map((q) => [q.n, q.name]), [[2, "Near"], [3, "Mid"], [1, "Far"]]);
  assert.ok(near(m.pois[0].distanceM, 111, 2), String(m.pois[0].distanceM));
  assert.ok(near(m.pois[2].distanceM, 1112, 5), String(m.pois[2].distanceM));
});

test("a line: perpendicular distance to the seekers' drawn line, not to its vertices", () => {
  // A north–south line 0.01° of longitude east of HERE (~1.05 km at 19°N), long enough that the
  // nearest point is mid-segment.
  const ref = refOf("measuring", { refType: "line", refLabel: "Coastline", refCard: "coastline",
    refGeometry: { type: "LineString", coordinates: [[72.81, 18.9], [72.81, 19.1]] } }, { distanceM: 900 });
  const m = measureAgainstRef(ref, HERE);
  assert.equal(m.lines.length, 1);
  assert.ok(near(m.lines[0].distanceM, 1052, 10), String(m.lines[0].distanceM));
});

test("several lines are ranked, each keeping the seekers' id and name", () => {
  const ref = refOf("matching", { mode: "nearestLine", category: "street", categoryLabel: "Street or Path", source: "drawn", lines: [
    { id: "a", label: "Far path", coords: [{ lat: 18.9, lng: 72.83 }, { lat: 19.1, lng: 72.83 }] },
    { id: "b", label: "Near path", coords: [{ lat: 18.9, lng: 72.802 }, { lat: 19.1, lng: 72.802 }] },
  ] }, { nearestLine: "a" });
  const m = measureAgainstRef(ref, HERE);
  assert.deepEqual(m.lines.map((l) => l.id), ["b", "a"]);
});

test("regions: inside/outside and the distance to the edge, from either side", () => {
  const ring = [[18.99, 72.79], [18.99, 72.81], [19.01, 72.81], [19.01, 72.79]];
  const ref = refOf("matching", { mode: "region", category: "admin2", categoryLabel: "2nd Admin. Division", ring });
  const inside = measureAgainstRef(ref, HERE).polygons[0];
  assert.equal(inside.inside, true);
  assert.ok(near(inside.edgeDistanceM, 1052, 15), String(inside.edgeDistanceM)); // 0.01° lng to the E/W edges
  const outside = measureAgainstRef(ref, { lat: 19.0, lng: 72.83 }).polygons[0];
  assert.equal(outside.inside, false);
  assert.ok(near(outside.edgeDistanceM, 2104, 20), String(outside.edgeDistanceM));
});

test("tentacles: distance to the seekers' position, with their reach beside it", () => {
  const ref = refOf("tentacles", { category: "museum", categoryLabel: "Museums", radius: 2000,
    center: { lat: 19.01, lng: 72.8 }, features: [{ lat: 19.001, lng: 72.8, name: "A" }] });
  const m = measureAgainstRef(ref, HERE);
  assert.ok(near(m.center.distanceM, 1112, 5));
  assert.equal(m.center.radiusM, 2000);
});

test("no position, no measurement — it never invents one", () => {
  const ref = refOf("tentacles", { category: "m", categoryLabel: "M", radius: 2000, center: HERE, features: [HERE].map((p) => ({ ...p, name: "x" })) });
  assert.throws(() => measureAgainstRef(ref, null), /No position/);
  assert.throws(() => measureAgainstRef(ref, { lat: NaN, lng: 1 }), /No position/);
});

test("WALL: the output is measurements only — no answer-shaped field anywhere", () => {
  const ref = refOf("matching", { mode: "nearest", category: "museum", categoryLabel: "Museum", features: [
    { lat: 19.001, lng: 72.8, name: "A" }, { lat: 19.002, lng: 72.8, name: "B" },
  ] }, { nearest: 2 });
  const m = measureAgainstRef(ref, HERE);
  const ALLOWED = new Set(["pois", "lines", "polygons", "center", "n", "name", "id", "role", "distanceM", "inside", "edgeDistanceM", "radiusM"]);
  const walk = (o, path = "") => {
    if (Array.isArray(o)) return o.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
      assert.ok(ALLOWED.has(k), `measure aid returned "${path}.${k}" — only measurements are allowed`);
      walk(v, `${path}.${k}`);
    }
  };
  walk(m);
  // In particular it does not compare with the seekers' side: the seekers' nearest (#2) is not
  // flagged, and nothing says "same" or "closer".
  assert.ok(!/same|closer|farther|match|keep|answer|verdict|within/i.test(JSON.stringify(m)));
});

const srcFiles = (dir = SRC, prefix = "") => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? srcFiles(join(dir, e.name), `${prefix}${e.name}/`) : e.name.endsWith(".js") ? [{ rel: `${prefix}${e.name}`, abs: join(dir, e.name) }] : []);
const code = (abs) => readFileSync(abs, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("WALL: only the hider's received-reference view imports the measure aid", () => {
  const importers = srcFiles()
    .filter(({ abs }) => /(?:from|import)\s*\(?\s*["'][^"']*measure-aid\.js["']/.test(code(abs)))
    .map(({ rel }) => rel);
  assert.deepEqual(importers, ["received.js"],
    "measure-aid.js must be reachable only from received.js. A seeker flow, the elimination engine or " +
    "anything that records a step importing it would turn a hider-side measurement into the app answering.");
});

test("WALL: the received-reference view never writes a question", () => {
  const src = code(join(SRC, "received.js"));
  for (const banned of [/addStep\s*\(/, /\.history\b/, /createStep\s*\(/, /redoStack/]) {
    assert.ok(!banned.test(src), `received.js matches ${banned} — a received reference must never become a step on this phone`);
  }
});
