// B1 — pagination must not stop at exactly 20 results.
//
// The code contradicted its own comment: "The next-page token needs ~2 s to activate" sat
// directly above `setTimeout(() => pagination.nextPage(), 1600)`. When the token wasn't
// ready, nextPage() returned INVALID_REQUEST, and the fallback `else if (all.length)
// resolve(all)` quietly resolved page one — the likely proximate cause of "most lists only
// contain 20 elements", rather than Google's 60 cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchCategory } from "../src/places.js";

// --- Minimal google.maps.places stand-in ---------------------------------------------
const S = { OK: "OK", ZERO_RESULTS: "ZERO_RESULTS", INVALID_REQUEST: "INVALID_REQUEST", ERROR: "ERROR" };

const place = (i) => ({
  place_id: `p${i}`,
  name: `Place ${i}`,
  geometry: { location: { lat: () => 19 + i * 1e-4, lng: () => 72.8 + i * 1e-4 } },
});
const page = (start, n = 20) => Array.from({ length: n }, (_, k) => place(start + k));

// places.js caches its PlacesService in a MODULE-LEVEL singleton (`if (!service) service =
// new google.maps.places.PlacesService(map)`), so it is created once for the whole test
// file and a fresh map object won't produce a fresh service. The fake is therefore one
// stable service that reads a mutable per-test config.
let config = null;

const svc = {
  nearbySearch(req, cb) {
    const { pages, tokenReadyAfterMs, hardStatus } = config;
    if (hardStatus) return cb(null, hardStatus, null);
    let idx = 0;
    let lastServedAt = 0;
    const serve = () => {
      lastServedAt = Date.now();
      const pagination = {
        hasNextPage: idx < pages.length - 1,
        nextPage() {
          // The real API rejects a next-page token spent before it activates.
          if (Date.now() - lastServedAt < tokenReadyAfterMs) return cb(null, S.INVALID_REQUEST, null);
          idx++;
          serve();
        },
      };
      cb(pages[idx], S.OK, pagination);
    };
    serve();
  },
};

globalThis.google = {
  maps: { places: { PlacesService: function () { return svc; }, PlacesServiceStatus: S } },
};

const fakeMaps = (cfg) => { config = { tokenReadyAfterMs: 0, hardStatus: null, ...cfg }; };
const fakeMap = {};

test("follows all three pages to 60 results when tokens activate promptly", async () => {
  fakeMaps({ pages: [page(0), page(20), page(40)], tokenReadyAfterMs: 0 });
  const out = await searchCategory(fakeMap, { center: { lat: 19, lng: 72.8 }, radius: 5000, type: "train_station" });
  assert.equal(out.length, 60, "all three pages should be followed");
});

test("a token that needs ~2 s no longer caps the list at 20", async () => {
  // The regression: with a 1600 ms wait against a 2000 ms token this resolved 20 and
  // reported success. The delay is now 2500 ms, so the token is live.
  fakeMaps({ pages: [page(0), page(20), page(40)], tokenReadyAfterMs: 2000 });
  const out = await searchCategory(fakeMap, { center: { lat: 19, lng: 72.8 }, radius: 5000, type: "train_station" });
  assert.notEqual(out.length, 20, "must not stop at exactly one page");
  assert.equal(out.length, 60);
});

test("retries once when a token is still cold, rather than resolving page one", async () => {
  // Token needs slightly longer than our wait: the first nextPage() gets INVALID_REQUEST.
  // Without the retry this resolved 20 results and looked like a complete answer.
  fakeMaps({ pages: [page(0), page(20)], tokenReadyAfterMs: 3000 });
  const out = await searchCategory(fakeMap, { center: { lat: 19, lng: 72.8 }, radius: 5000, type: "train_station" });
  assert.equal(out.length, 40, "the retry should recover page two");
});

test("de-dupes places repeated across pages", async () => {
  fakeMaps({ pages: [page(0), page(10)], tokenReadyAfterMs: 0 }); // 10 overlap
  const out = await searchCategory(fakeMap, { center: { lat: 19, lng: 72.8 }, radius: 5000, type: "train_station" });
  assert.equal(out.length, 30, "20 + 20 with 10 shared ids = 30 unique");
});

test("respects maxPages", async () => {
  fakeMaps({ pages: [page(0), page(20), page(40)], tokenReadyAfterMs: 0 });
  const out = await searchCategory(fakeMap, { center: { lat: 19, lng: 72.8 }, radius: 5000, type: "train_station", maxPages: 2 });
  assert.equal(out.length, 40);
});

test("a single-page result still resolves", async () => {
  fakeMaps({ pages: [page(0, 7)], tokenReadyAfterMs: 0 });
  const out = await searchCategory(fakeMap, { center: { lat: 19, lng: 72.8 }, radius: 5000, type: "zoo" });
  assert.equal(out.length, 7);
});

test("a hard failure on page one still rejects", async () => {
  fakeMaps({ pages: [], hardStatus: S.ERROR });
  await assert.rejects(
    () => searchCategory(fakeMap, { center: { lat: 19, lng: 72.8 }, radius: 5000, type: "zoo" }),
    /Places search failed/,
  );
});

test("ZERO_RESULTS resolves empty rather than rejecting", async () => {
  fakeMaps({ pages: [], hardStatus: S.ZERO_RESULTS });
  const out = await searchCategory(fakeMap, { center: { lat: 19, lng: 72.8 }, radius: 5000, type: "zoo" });
  assert.deepEqual(out, []);
});
