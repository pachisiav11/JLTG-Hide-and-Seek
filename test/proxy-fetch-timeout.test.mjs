// C1-6: the two client-side proxy fetches had no timeout.
//
// `overpass.js:56` passes `AbortSignal.timeout(45000)` because "fetch has NO default timeout: a
// stalled endpoint otherwise hangs forever while looking like work in progress". The same is
// true one layer out, and neither client call had it:
//
//     lines.js  fetchFromProxy         -> /overpass/lines
//     lines.js  loadCountryDivisions   -> /overpass/divisions
//
// Observed live during cycle 2, not merely read: a `/overpass/lines?kind=coastline` request for
// a Mumbai city bbox sat pending with no status and nothing to end it, and the flow waiting on
// it never returned.
//
// The fix is only safe because the cache ladder already treats a failed fetch as "use the copy
// we have". These tests pin exactly that: a timeout must fall back to the stale cache, and must
// only surface as an error when there is no cache to fall back to.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { squareArea } from "./helpers/turf-env.mjs";
import { loadLines as rawLoadLines, cacheKey, loadCountryDivisions } from "../src/lines.js";

const store = new Map();
const dbImpl = {
  get: async (_s, k) => store.get(k) || null,
  put: async (_s, v) => { store.set(v.key, v); },
};
const loadLines = (kind, bbox, opts = {}) => rawLoadLines(kind, bbox, { dbImpl, ...opts });

const payload = { kind: "rail", lines: [{ name: "Western Line", ref: "W", wayIds: [1] }], ways: { 1: [[19.07, 72.87], [19.08, 72.87]] } };

// What an aborted fetch actually throws, so the fallback is exercised the way it will be hit.
const abortError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

test("both client proxy calls pass an abort signal", () => {
  const src = readFileSync(new URL("../src/lines.js", import.meta.url), "utf8");
  const calls = src.match(/await fetch\(url\.toString\(\)[^)]*\)/g) || [];
  assert.ok(calls.length >= 2, `expected both proxy fetches, found ${calls.length}`);
  for (const c of calls) {
    assert.match(c, /AbortSignal\.timeout\(PROXY_FETCH_TIMEOUT_MS\)/,
      `a proxy fetch still has no timeout: ${c}`);
  }
});

test("the timeout is a named constant, not a magic number", () => {
  const src = readFileSync(new URL("../src/lines.js", import.meta.url), "utf8");
  assert.match(src, /const PROXY_FETCH_TIMEOUT_MS = \d+/);
});

test("a timed-out lines fetch serves the stale cache rather than failing", () => {
  return (async () => {
    store.clear();
    const bbox = "A";
    store.set(cacheKey("rail", bbox), {
      key: cacheKey("rail", bbox), fetchedAt: 0, data: payload, // fetchedAt 0 -> stale
    });
    globalThis.fetch = async () => { throw abortError(); };
    const out = await loadLines("rail", bbox, { proxyBase: "http://proxy.test", now: Date.now() });
    assert.equal(out.from, "cache-stale", "an aborted fetch must fall back, not throw");
    assert.equal(out.lines[0].ref, "W", "and must serve the real cached payload");
  })();
});

test("a timed-out fetch with NO cache still surfaces as an error", async () => {
  // The fallback must not turn an outage into a silent empty board.
  store.clear();
  globalThis.fetch = async () => { throw abortError(); };
  await assert.rejects(
    () => loadLines("rail", "B", { proxyBase: "http://proxy.test", now: Date.now() }),
    /aborted|timeout/i,
    "with nothing cached there is no answer, and that must be said",
  );
});

test("a timed-out divisions probe falls back to its cache too", async () => {
  store.clear();
  const key = `divisions|19.08|72.88`;
  store.set(key, { key, kind: "divisions", fetchedAt: 0, data: { country: "India", levels: [4, 5] } });
  globalThis.fetch = async () => { throw abortError(); };
  const out = await loadCountryDivisions(19.08, 72.88, { proxyBase: "http://proxy.test", dbImpl, now: Date.now() });
  assert.equal(out.country, "India", "a stale division answer beats no answer outdoors");
});

test("a successful fetch is unaffected by the signal", async () => {
  store.clear();
  let sawSignal = false;
  globalThis.fetch = async (_u, opts) => {
    sawSignal = !!opts?.signal;
    return { ok: true, json: async () => payload };
  };
  const out = await loadLines("rail", "C", { proxyBase: "http://proxy.test", now: Date.now() });
  assert.ok(sawSignal, "the signal must actually be passed to fetch");
  assert.equal(out.from, "network");
  assert.equal(out.lines[0].ref, "W");
});
