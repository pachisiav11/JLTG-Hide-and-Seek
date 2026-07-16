// B2 — Overpass must be reachable for COMPLETENESS, not only on failure.
//
// The old rule: `if (!googleErr && feats.length >= THIN) return google`, THIN = 2. Google's
// nearbySearch hard-caps at 60. In London, Google returns its 60-station cap, 60 >= 2, and
// the ~400-station OSM dataset was never consulted. Overpass only ever fired on API
// *failure*, never for *completeness* — so the cap, not the data, decided the partition.
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchCategoryResilient } from "../src/places.js";

const S = { OK: "OK", ZERO_RESULTS: "ZERO_RESULTS", ERROR: "ERROR", INVALID_REQUEST: "INVALID_REQUEST" };

const gPlace = (i) => ({
  place_id: `g${i}`, name: `Google Place ${i}`,
  geometry: { location: { lat: () => 51.5 + i * 1e-4, lng: () => -0.12 + i * 1e-4 } },
});

// --- fakes ---------------------------------------------------------------------------
let googleCfg, overpassCfg, calls;

const svc = {
  nearbySearch(req, cb) {
    calls.push("google");
    if (googleCfg.status && googleCfg.status !== S.OK) return cb(null, googleCfg.status, null);
    // Serve `count` places, honouring pagination up to Google's 3-page/60 ceiling.
    const all = Array.from({ length: googleCfg.count }, (_, i) => gPlace(i));
    let served = 0;
    const serve = () => {
      const page = all.slice(served, served + 20);
      served += page.length;
      cb(page, S.OK, { hasNextPage: served < all.length, nextPage: () => setTimeout(serve, 0) });
    };
    serve();
  },
};

globalThis.google = { maps: { places: { PlacesService: function () { return svc; }, PlacesServiceStatus: S } } };

// turf is only needed for areaBboxSWNE; a tiny stub avoids loading the real bundle.
const AREA = { type: "Polygon", coordinates: [[[-0.5, 51.3], [0.3, 51.3], [0.3, 51.7], [-0.5, 51.7], [-0.5, 51.3]]] };
globalThis.window = {
  turf: { bbox: () => [-0.5, 51.3, 0.3, 51.7], feature: (g) => ({ type: "Feature", geometry: g }) },
  JLTG_CONFIG: { OVERPASS_PROXY_URL: "https://proxy.test" },
};

globalThis.fetch = async () => {
  calls.push("overpass");
  if (overpassCfg.fail) throw new Error("Overpass proxy HTTP 502");
  return {
    ok: true,
    json: async () => ({
      features: Array.from({ length: overpassCfg.count }, (_, i) => ({ name: `OSM Place ${i}`, lat: 51.5, lng: -0.12 })),
    }),
  };
};

const setup = ({ google: g = {}, overpass: o = {} } = {}) => {
  googleCfg = { count: 0, status: S.OK, ...g };
  overpassCfg = { count: 0, fail: false, ...o };
  calls = [];
};

const run = (opts) => searchCategoryResilient({}, { center: { lat: 51.5, lng: -0.12 }, radius: 5000, gameArea: AREA, ...opts });

// --- the architectural fix -----------------------------------------------------------

test("the London case: 400 OSM stations beat Google's 60-cap", async () => {
  setup({ google: { count: 60 }, overpass: { count: 400 } });
  const { feats, source } = await run({ type: "train_station" });
  // The precise regression: 60 >= THIN(2), so the old code returned Google's cap and never
  // asked OSM. The board was partitioned from an arbitrary 60 of ~400 stations.
  assert.equal(source, "overpass");
  assert.equal(feats.length, 400);
});

test("dense cards ask Overpass FIRST — Google isn't called at all", async () => {
  setup({ google: { count: 60 }, overpass: { count: 400 } });
  await run({ type: "subway_station" });
  assert.deepEqual(calls, ["overpass"], "Google must not be consulted when OSM answered");
});

test("dense cards report OSM as the intended primary, not as a Places failure", async () => {
  setup({ google: { count: 60 }, overpass: { count: 400 } });
  const { source, reason } = await run({ type: "train_station" });
  // Assert BOTH: Google's own path also reports reason "primary", so checking `reason`
  // alone would pass against the pre-fix code and prove nothing.
  assert.equal(source, "overpass");
  assert.equal(reason, "primary");
  // The toast must not claim "Places was unavailable" — Places was never asked.
});

test("a sparse card still uses Google first", async () => {
  setup({ google: { count: 3 }, overpass: { count: 99 } });
  const { source, feats } = await run({ type: "zoo" });
  assert.equal(source, "google");
  assert.equal(feats.length, 3);
  assert.deepEqual(calls, ["google"], "no need to bother Overpass for a healthy sparse answer");
});

test("a NON-dense card that hits Google's cap still consults OSM (THIN could never catch this)", async () => {
  setup({ google: { count: 60 }, overpass: { count: 250 } });
  const { source, feats, reason } = await run({ type: "museum" });
  assert.equal(source, "overpass");
  assert.equal(feats.length, 250);
  assert.equal(reason, "uncapped", "a result AT the cap is truncated by definition");
});

test("a capped Google result is kept when OSM has no more to offer", async () => {
  setup({ google: { count: 60 }, overpass: { count: 12 } });
  const { source, feats } = await run({ type: "museum" });
  assert.equal(source, "google", "never trade 60 real results for 12");
  assert.equal(feats.length, 60);
});

// --- resilience: B2 puts a ~64%-failure dependency on the critical path ---------------

test("a dense card falls back to Google when Overpass is down", async () => {
  setup({ google: { count: 60 }, overpass: { fail: true } });
  const { source, feats, reason } = await run({ type: "train_station" });
  assert.equal(source, "google", "a capped answer beats no answer");
  assert.equal(feats.length, 60);
  assert.equal(reason, "fallback");
  assert.deepEqual(calls, ["overpass", "google"], "tries OSM first, then Google");
});

test("a dense card falls back to Google when Overpass returns nothing", async () => {
  // An empty OSM answer isn't authoritative — thin mapping or odd tagging for the region.
  setup({ google: { count: 8 }, overpass: { count: 0 } });
  const { source, feats } = await run({ type: "bus_station" });
  assert.equal(source, "google");
  assert.equal(feats.length, 8);
});

test("both sources failing surfaces the Google error rather than an empty list", async () => {
  setup({ google: { status: S.ERROR }, overpass: { fail: true } });
  await assert.rejects(() => run({ type: "train_station" }), /Places search failed/);
});

test("with no proxy configured everything stays Google-only", async () => {
  const cfg = window.JLTG_CONFIG;
  window.JLTG_CONFIG = {};
  try {
    setup({ google: { count: 60 }, overpass: { count: 400 } });
    const { source } = await run({ type: "train_station" });
    assert.equal(source, "google");
    assert.deepEqual(calls, ["google"]);
  } finally { window.JLTG_CONFIG = cfg; }
});

test("a card with no OSM mapping stays on Google even when capped", async () => {
  setup({ google: { count: 60 }, overpass: { count: 400 } });
  const { source } = await run({ type: "some_unmapped_type" });
  assert.equal(source, "google");
  assert.deepEqual(calls, ["google"], "no Overpass category ⇒ nothing to ask");
});
