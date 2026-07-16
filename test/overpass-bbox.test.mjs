// B6 — the Overpass query must respect the caller's centre and radius.
//
// The bbox always came from areaBboxSWNE(gameArea), so a 2 km Museums tentacle on a 300 km
// board fell back to a query spanning the ENTIRE play area. That can time out, and the
// failure is only console.warn'd — so the caller silently received an empty candidate list
// and the seeker saw "no museums near you" rather than an error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchCategoryResilient } from "../src/places.js";

const S = { OK: "OK", ZERO_RESULTS: "ZERO_RESULTS", ERROR: "ERROR" };

const svc = { nearbySearch: (req, cb) => cb([], S.ZERO_RESULTS, null) };
globalThis.google = { maps: { places: { PlacesService: function () { return svc; }, PlacesServiceStatus: S } } };

// A ~300 km board.
const BIG_BOARD = { type: "Polygon", coordinates: [[[71.5, 17.7], [74.2, 17.7], [74.2, 20.4], [71.5, 20.4], [71.5, 17.7]]] };
const SEEKER = { lat: 19.076, lng: 72.8777 };

let lastBbox = null;
globalThis.window = {
  turf: { bbox: () => [71.5, 17.7, 74.2, 20.4], feature: (g) => ({ type: "Feature", geometry: g }) },
  JLTG_CONFIG: { OVERPASS_PROXY_URL: "https://proxy.test" },
};
globalThis.fetch = async (url) => {
  lastBbox = new URL(url).searchParams.get("bbox");
  return { ok: true, json: async () => ({ features: [{ name: "A Museum", lat: 19.08, lng: 72.88 }] }) };
};

const spanOf = (bboxStr) => {
  const [s, w, n, e] = bboxStr.split(",").map(Number);
  return { latDeg: +(n - s).toFixed(4), lngDeg: +(e - w).toFixed(4) };
};

test("a 2 km tentacle queries a ~2 km disc, not the whole 300 km board", () => {
  return searchCategoryResilient({}, {
    center: SEEKER, radius: 2000, type: "museum", gameArea: BIG_BOARD, boundToRadius: true,
  }).then(() => {
    const { latDeg, lngDeg } = spanOf(lastBbox);
    // 2 km radius => ~4 km across => ~0.036° of latitude. The board is 2.7°.
    assert.ok(latDeg < 0.1, `expected a small disc bbox, got ${latDeg}° of latitude`);
    assert.ok(lngDeg < 0.1, `expected a small disc bbox, got ${lngDeg}° of longitude`);
  });
});

test("the disc is centred on the SEEKER, not the board's centroid", () => {
  return searchCategoryResilient({}, {
    center: SEEKER, radius: 2000, type: "museum", gameArea: BIG_BOARD, boundToRadius: true,
  }).then(() => {
    const [s, w, n, e] = lastBbox.split(",").map(Number);
    assert.ok(s < SEEKER.lat && SEEKER.lat < n, "the seeker must be inside the queried box");
    assert.ok(w < SEEKER.lng && SEEKER.lng < e);
  });
});

// Sequential, never concurrent: `lastBbox` is a shared global, so overlapping calls would
// both read whichever wrote last.
const askSpan = async (opts) => {
  await searchCategoryResilient({}, { center: SEEKER, type: "museum", gameArea: BIG_BOARD, ...opts });
  return spanOf(lastBbox).latDeg;
};

test("a 25 km tentacle queries a bigger disc than a 2 km one", async () => {
  const small = await askSpan({ radius: 2000, boundToRadius: true });
  const big = await askSpan({ radius: 25000, boundToRadius: true });
  assert.ok(big > small * 5, `25 km disc (${big}°) should dwarf the 2 km one (${small}°)`);
});

test("Matching/Measuring still query the WHOLE board", async () => {
  // Their radius comes from the board diagonal and is clamped to Google's 50 km ceiling —
  // a Google limitation, not the seeker's intent. Shrinking their bbox to that disc would
  // lose the board's edges, which is B5's bug reintroduced through the back door.
  await searchCategoryResilient({}, {
    center: SEEKER, radius: 50000, type: "museum", gameArea: BIG_BOARD, // no boundToRadius
  });
  const { latDeg } = spanOf(lastBbox);
  assert.ok(latDeg > 2, `expected the full board (2.7°), got ${latDeg}°`);
});

test("padMeters still widens a radius-bound query", async () => {
  const none = await askSpan({ radius: 2000, boundToRadius: true, padMeters: 0 });
  const padded = await askSpan({ radius: 2000, boundToRadius: true, padMeters: 5000 });
  assert.ok(padded > none, `padding must still apply to the disc (${padded}° vs ${none}°)`);
});

test("boundToRadius with no centre falls back to the board rather than producing nothing", async () => {
  await searchCategoryResilient({}, {
    center: null, radius: 2000, type: "museum", gameArea: BIG_BOARD, boundToRadius: true,
  });
  const { latDeg } = spanOf(lastBbox);
  assert.ok(latDeg > 2, "no centre ⇒ fall back to the whole board, don't lose the query");
});
