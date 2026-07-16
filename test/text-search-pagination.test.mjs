// B4 — searchText must paginate.
//
// svc.textSearch was called with a plain callback that ignored the third `pagination`
// argument, unlike searchCategory. Every text search was capped at Google's first page of
// 20; the match the seeker wanted could sit at rank 21+ and was unreachable at any cost.
// features.js then sliced that to 8.
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchText } from "../src/places.js";

const S = { OK: "OK", ZERO_RESULTS: "ZERO_RESULTS", ERROR: "ERROR", INVALID_REQUEST: "INVALID_REQUEST" };

const result = (i) => ({
  place_id: `t${i}`,
  name: `Result ${i}`,
  formatted_address: `${i} Some Road`,
  geometry: { location: { lat: () => 51.5 + i * 1e-4, lng: () => -0.12 + i * 1e-4 } },
});

// places.js caches its PlacesService in a module-level singleton, so the fake is one stable
// service reading a mutable per-test config (same shape as the searchCategory tests).
let config;
const svc = {
  textSearch(req, cb) {
    if (config.status && config.status !== S.OK) return cb(null, config.status, null);
    const all = Array.from({ length: config.count }, (_, i) => result(i));
    let served = 0;
    let firstTokenUse = true;
    const serve = () => {
      const page = all.slice(served, served + 20);
      served += page.length;
      cb(page, S.OK, {
        hasNextPage: served < all.length,
        nextPage: () => {
          // Optionally reject the first token use, like a cold token.
          if (config.coldToken && firstTokenUse) { firstTokenUse = false; return cb(null, S.INVALID_REQUEST, null); }
          setTimeout(serve, 0);
        },
      });
    };
    serve();
  },
};
globalThis.google = { maps: { places: { PlacesService: function () { return svc; }, PlacesServiceStatus: S } } };

const setup = (cfg) => { config = { count: 0, status: S.OK, coldToken: false, ...cfg }; };
const fakeMap = {};

test("the regression: a 3-page result is no longer capped at 20", async () => {
  setup({ count: 55 });
  const out = await searchText(fakeMap, "station");
  assert.notEqual(out.length, 20, "must not stop at Google's first page");
  assert.equal(out.length, 55);
});

test("a rank-21+ match is now reachable", async () => {
  setup({ count: 40 });
  const out = await searchText(fakeMap, "station");
  assert.ok(out.some((r) => r.name === "Result 25"), "the match the seeker wanted was unreachable before");
});

test("retries a cold next-page token rather than resolving page one", async () => {
  setup({ count: 40, coldToken: true });
  const out = await searchText(fakeMap, "station");
  assert.equal(out.length, 40);
});

test("keeps the result shape callers rely on", async () => {
  setup({ count: 1 });
  const [r] = await searchText(fakeMap, "x");
  assert.deepEqual(Object.keys(r).sort(), ["address", "lat", "lng", "name"]);
  assert.equal(r.address, "0 Some Road");
});

test("de-dupes repeated place ids across pages", async () => {
  setup({ count: 25 });
  const out = await searchText(fakeMap, "x");
  assert.equal(new Set(out.map((r) => r.name)).size, out.length);
});

test("respects maxPages", async () => {
  setup({ count: 60 });
  const out = await searchText(fakeMap, "x", { maxPages: 1 });
  assert.equal(out.length, 20);
});

test("a single short page still resolves", async () => {
  setup({ count: 3 });
  assert.equal((await searchText(fakeMap, "x")).length, 3);
});

test("ZERO_RESULTS resolves empty; a hard error rejects", async () => {
  setup({ count: 0, status: S.ZERO_RESULTS });
  assert.deepEqual(await searchText(fakeMap, "x"), []);
  setup({ count: 0, status: S.ERROR });
  await assert.rejects(() => searchText(fakeMap, "x"), /Search failed/);
});
