// v2 Phase 2, item F — derive the seeker's own distance instead of asking for it.
//
// The measuring cards buffer a reference geometry by the seeker's distance to it, and until
// now the seeker typed that number. The app was holding both operands the whole time: the
// GPS fix and the reference it is about to buffer. Typing the number between them is a pure
// error surface — a paced estimate, a metres/feet slip, a stale value from the previous
// question — and every one of those lands as a confidently wrong elimination that looks
// exactly like a right one.
//
// `distanceToGeometryM` is the whole of the derivation. It has to be right for every
// reference shape the cards produce, which is what these pin. The polygon case is the one
// with a judgement call in it, and it gets its own test.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf } from "./helpers/turf-env.mjs";
import { distanceToGeometryM, distanceToLinePathsM } from "../src/geo.js";

const P = { lat: 19.076, lng: 72.8777 };

// Ground truth from turf directly, so the test is not just re-running the implementation.
const truth = (a, b) => turf.distance(turf.point([a.lng, a.lat]), turf.point(b), { units: "meters" });

test("Point reference: distance to the point", () => {
  const target = [72.9, 19.1];
  const got = distanceToGeometryM(P, { type: "Point", coordinates: target });
  assert.ok(Math.abs(got - truth(P, target)) < 1, `got ${got}`);
});

test("MultiPoint reference: distance to the NEAREST point, not the first or the mean", () => {
  const near = [72.88, 19.08];
  const far = [73.2, 19.4];
  // Deliberately lists the far one first: an implementation that returns the first match,
  // or averages, fails here and would otherwise buffer by a wildly wrong radius.
  const got = distanceToGeometryM(P, { type: "MultiPoint", coordinates: [far, near] });
  assert.ok(Math.abs(got - truth(P, near)) < 1, `got ${got}, expected the near point`);
});

test("LineString reference: perpendicular distance, not distance to a vertex", () => {
  // A due-east line north of P. The nearest point is the perpendicular foot, which lies
  // between the vertices — measuring to the closest VERTEX would overstate it.
  const line = { type: "LineString", coordinates: [[72.5, 19.2], [73.3, 19.2]] };
  const got = distanceToGeometryM(P, line);
  const toVertex = Math.min(truth(P, [72.5, 19.2]), truth(P, [73.3, 19.2]));
  const perpendicular = truth(P, [P.lng, 19.2]);
  assert.ok(Math.abs(got - perpendicular) < 50, `got ${got}, expected ~${perpendicular}`);
  assert.ok(got < toVertex * 0.5, "and must be well under the nearest-vertex distance");
});

test("MultiLineString reference: the nearest of many disjoint parts", () => {
  // This is the ordinary shape for a sourced coastline or border — many OSM ways, never one.
  const geom = {
    type: "MultiLineString",
    coordinates: [
      [[72.5, 19.6], [73.3, 19.6]], // far
      [[72.5, 19.10], [73.3, 19.10]], // near
    ],
  };
  const got = distanceToGeometryM(P, geom);
  const nearPerp = truth(P, [P.lng, 19.10]);
  assert.ok(Math.abs(got - nearPerp) < 50, `got ${got}, expected ~${nearPerp}`);
});

// The judgement call. A seeker standing INSIDE the reference area is at distance zero from
// it. Measuring to the boundary unconditionally would make someone standing in a park answer
// "beyond the nearest park", which is both false and impossible to reason about.
test("Polygon reference: inside is zero, outside measures to the edge", () => {
  const h = 0.05;
  const poly = {
    type: "Polygon",
    coordinates: [[
      [P.lng - h, P.lat - h], [P.lng + h, P.lat - h],
      [P.lng + h, P.lat + h], [P.lng - h, P.lat + h], [P.lng - h, P.lat - h],
    ]],
  };
  assert.equal(distanceToGeometryM(P, poly), 0, "a point inside the reference is at zero distance");

  const outside = { lat: P.lat, lng: P.lng + 0.15 };
  const got = distanceToGeometryM(outside, poly);
  const toEdge = truth(outside, [P.lng + h, P.lat]);
  assert.ok(got > 0 && Math.abs(got - toEdge) < 50, `got ${got}, expected ~${toEdge}`);
});

test("unknown or missing geometry yields Infinity rather than throwing or lying", () => {
  // Returning 0 here would silently buffer by nothing and eliminate the whole board;
  // returning Infinity is caught by the caller's `Number.isFinite` guard and falls back to
  // manual entry, which is the safe direction.
  assert.equal(distanceToGeometryM(P, null), Infinity);
  assert.equal(distanceToGeometryM(P, { type: "Nonsense", coordinates: [] }), Infinity);
});

test("GeometryCollection takes the nearest member", () => {
  const geom = {
    type: "GeometryCollection",
    geometries: [
      { type: "Point", coordinates: [73.3, 19.5] },
      { type: "Point", coordinates: [72.88, 19.08] },
    ],
  };
  const got = distanceToGeometryM(P, geom);
  assert.ok(Math.abs(got - truth(P, [72.88, 19.08])) < 1, `got ${got}`);
});

test("line-object paths: the nearest path of a multi-path line", () => {
  const paths = [
    [{ lat: 19.6, lng: 72.5 }, { lat: 19.6, lng: 73.3 }],
    [{ lat: 19.12, lng: 72.5 }, { lat: 19.12, lng: 73.3 }],
  ];
  const got = distanceToLinePathsM(P, paths);
  const nearPerp = truth(P, [P.lng, 19.12]);
  assert.ok(Math.abs(got - nearPerp) < 50, `got ${got}, expected ~${nearPerp}`);
});

test("line-object paths: degenerate paths are skipped, not counted as zero", () => {
  // A one-point "path" has no length; treating it as a line would throw, and treating it as
  // a hit would derive a distance of zero and buffer by nothing.
  const paths = [
    [{ lat: 19.12, lng: 72.88 }],               // degenerate
    [{ lat: 19.12, lng: 72.5 }, { lat: 19.12, lng: 73.3 }],
  ];
  const got = distanceToLinePathsM(P, paths);
  assert.ok(Number.isFinite(got) && got > 0, `got ${got}`);
});

test("no usable paths at all yields Infinity", () => {
  assert.equal(distanceToLinePathsM(P, []), Infinity);
  assert.equal(distanceToLinePathsM(P, null), Infinity);
});
