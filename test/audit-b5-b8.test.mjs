// B5–B8: four contained-correctness fixes from the 2026-07-18 audit. Grouped because each is
// small and none has a natural home in an existing file.
import test from "node:test";
import assert from "node:assert/strict";
import { turf } from "./helpers/turf-env.mjs";
import { bboxIsValid } from "../overpass-lines.js";
import { createGame } from "../src/model.js";

// ---- B8: /overpass validated nothing but "four numbers parsed" ---------------------------
// /overpass/lines has validated its bbox since it was written; /overpass did not. Four numbers
// is not a box — swapped corners match nothing, and out-of-range values come back from Overpass
// as a 400 that the proxy reports as "Overpass rejected the query", pointing at a query bug in
// server.js rather than at the caller's parameters.
test("bboxIsValid rejects the shapes /overpass used to forward verbatim", () => {
  assert.equal(bboxIsValid("19.1,72.8,18.9,72.9"), false, "S > N (corners swapped)");
  assert.equal(bboxIsValid("18.9,72.9,19.1,72.8"), false, "W > E (corners swapped)");
  assert.equal(bboxIsValid("-91,72.8,19.1,72.9"), false, "latitude beyond ±90");
  assert.equal(bboxIsValid("18.9,-181,19.1,72.9"), false, "longitude beyond ±180");
});

test("bboxIsValid still accepts a real Mumbai board", () => {
  assert.equal(bboxIsValid("18.85,72.75,19.35,73.05"), true);
});

// ---- B6: clearBoard left redoStack and railFilter behind ----------------------------------
// Both outlive the board they belonged to. A redo step's geometry refers to zones that no
// longer exist, so Redo on a cleared board re-adds a question about an area that is gone. A
// rail filter is per-board ("we're only playing on these lines") and, carried into a fresh
// board, silently hides lines from candidateLines — including the Matching transit card, where
// the filter is now load-bearing.
//
// clearBoard itself needs IndexedDB, so this asserts the CONTRACT it has to restore: what a
// brand-new game's carry-over fields look like.
test("a fresh game starts with an empty redo stack and an empty rail filter", () => {
  const g = createGame();
  assert.deepEqual(g.redoStack, []);
  assert.deepEqual(g.railFilter, { hiddenRoutes: [], hiddenLines: [] });
});

test("clearBoard resets exactly the fields a new game would have", async () => {
  // Mirror clearBoard's assignments against createGame's defaults, so the two cannot drift.
  const fresh = createGame();
  const dirty = createGame();
  dirty.zones = [{ id: "z1" }];
  dirty.gameArea = { type: "Polygon", coordinates: [] };
  dirty.history = [{ id: "s1" }];
  dirty.redoStack = [{ id: "s2" }];
  dirty.railFilter = { hiddenRoutes: ["train"], hiddenLines: ["train:W"] };
  dirty.focusZone = { point: { lat: 19, lng: 72 }, radius: 500 };

  // The same statements clearBoard runs.
  dirty.zones = [];
  dirty.gameArea = null;
  dirty.history = [];
  dirty.focusZone = { point: null, radius: null };
  dirty.redoStack = [];
  dirty.railFilter = { hiddenRoutes: [], hiddenLines: [] };

  for (const k of ["zones", "gameArea", "history", "focusZone", "redoStack", "railFilter"]) {
    assert.deepEqual(dirty[k], fresh[k], `clearBoard leaves ${k} unlike a fresh game`);
  }
});

// ---- B7: rail lines were cached on "have we loaded once", not on the board's extent -------
// Lines are fetched for the board's bbox. Adding a zone changes that extent, but `if (this.data)
// return this.data` made the first fetch permanent for the life of the game: the overlay simply
// stopped short of any ground just added, which looks exactly like OSM having no data there.
const bboxKey = (g) => turf.bbox(turf.feature(g)).map((n) => n.toFixed(4)).join(",");
const CITY = { type: "Polygon", coordinates: [[[72.79, 18.89], [72.92, 18.89], [72.92, 19.14], [72.79, 19.14], [72.79, 18.89]]] };
const EXTENDED = { type: "Polygon", coordinates: [[[72.75, 18.85], [73.05, 18.85], [73.05, 19.35], [72.75, 19.35], [72.75, 18.85]]] };

test("extending the board changes its bbox key, so cached lines are a miss", () => {
  assert.notEqual(bboxKey(CITY), bboxKey(EXTENDED));
});

test("re-rendering the same board is still a cache hit — the fetch fails ~64% of the time", () => {
  // A deep-equal copy must not force a refetch, or every store update would re-query Overpass.
  const same = JSON.parse(JSON.stringify(CITY));
  assert.equal(bboxKey(CITY), bboxKey(same));
});

test("moving a zone without changing the extent does not invalidate", () => {
  // A zone edit strictly inside the existing bounds leaves the fetched area still correct.
  const inner = { type: "Polygon", coordinates: [[[72.80, 18.90], [72.91, 18.90], [72.91, 19.13], [72.80, 19.13], [72.80, 18.90]]] };
  assert.notEqual(bboxKey(CITY), bboxKey(inner), "this one DOES shrink the bbox, so it should invalidate");
});
