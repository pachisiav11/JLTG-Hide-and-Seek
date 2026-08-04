// The build check's job is to be right about staleness AND to be harmless when it cannot
// tell. The second half is what these tests spend most of their effort on: this code runs
// on a phone whose network is the thing under suspicion, so every way a fetch can fail has
// to end in a quiet "unknown" rather than an exception that reaches startup.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBuildId,
  compareBuilds,
  fetchDeployedBuild,
  checkDeployedBuild,
  describeBuildComparison,
} from "../src/version-check.js";

// A fetch stub that records what it was asked for, so the cache-defeating behaviour can be
// asserted rather than assumed.
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return handler(url, opts); };
  fn.calls = calls;
  return fn;
}
const jsonResponse = (body, ok = true, status = 200) => ({
  ok, status, json: async () => body,
});

test("normalizeBuildId keeps real commits and rejects non-identities", () => {
  assert.equal(normalizeBuildId("a1b2c3d"), "a1b2c3d");
  assert.equal(normalizeBuildId("  a1b2c3d  "), "a1b2c3d");
  // "dev" is what build-info.js emits with no RENDER_GIT_COMMIT. Treating it as a commit
  // would make two unrelated local builds compare equal and report "up to date".
  assert.equal(normalizeBuildId("dev"), null);
  assert.equal(normalizeBuildId("unknown"), null);
  assert.equal(normalizeBuildId(""), null);
  assert.equal(normalizeBuildId("   "), null);
  assert.equal(normalizeBuildId(undefined), null);
  assert.equal(normalizeBuildId(null), null);
  assert.equal(normalizeBuildId(12345), null);
});

test("compareBuilds: same commit is a match", () => {
  const r = compareBuilds("a1b2c3d", "a1b2c3d");
  assert.equal(r.status, "match");
  assert.equal(r.loaded, "a1b2c3d");
  assert.equal(r.deployed, "a1b2c3d");
});

test("compareBuilds: different commits differ, and both are reported", () => {
  const r = compareBuilds("a1b2c3d", "9f8e7d6");
  assert.equal(r.status, "differs");
  // Naming both is the entire point of the feature — a verdict without the two ids
  // answers "something changed" instead of "which build am I on".
  assert.equal(r.loaded, "a1b2c3d");
  assert.equal(r.deployed, "9f8e7d6");
});

test("compareBuilds: a missing side is unknown, never a mismatch", () => {
  // The dangerous failure mode: reporting "OUT OF DATE" to someone whose network merely
  // hiccuped. An absent answer must stay absent.
  assert.equal(compareBuilds("a1b2c3d", null).status, "unknown");
  assert.equal(compareBuilds(null, "a1b2c3d").status, "unknown");
  assert.equal(compareBuilds("dev", "a1b2c3d").status, "unknown");
  assert.equal(compareBuilds("a1b2c3d", "dev").status, "unknown");
  assert.equal(compareBuilds(undefined, undefined).status, "unknown");
  // Two local builds must NOT read as "match" just because both say "dev".
  assert.equal(compareBuilds("dev", "dev").status, "unknown");
});

test("fetchDeployedBuild reads commit, fullCommit and builtAt", async () => {
  const f = stubFetch(() => jsonResponse({
    commit: "9f8e7d6", fullCommit: "9f8e7d6c5b4a39281706", builtAt: "2026-08-04T10:00:00.000Z",
  }));
  const got = await fetchDeployedBuild({ fetchImpl: f });
  assert.deepEqual(got, {
    commit: "9f8e7d6", fullCommit: "9f8e7d6c5b4a39281706", builtAt: "2026-08-04T10:00:00.000Z",
  });
});

test("fetchDeployedBuild defeats caches on the way out", async () => {
  const f = stubFetch(() => jsonResponse({ commit: "9f8e7d6" }));
  await fetchDeployedBuild({ fetchImpl: f, now: () => 1234567 });
  const { url, opts } = f.calls[0];
  // A cached answer to "is my cache stale" is worthless: it would be produced by the very
  // cache in question. Both defeats must be present, since either alone is ignorable by
  // some layer between the app and the origin.
  assert.match(url, /^version\.json\?t=1234567$/, "must carry a cache-busting query");
  assert.equal(opts.cache, "no-store", "must ask the HTTP cache to stand down");
});

test("fetchDeployedBuild appends the buster correctly to a url that already has a query", () => {
  return fetchDeployedBuild({
    fetchImpl: stubFetch((url) => {
      assert.match(url, /\?a=1&t=\d+$/, "must not produce a second '?'");
      return jsonResponse({ commit: "x" });
    }),
    url: "version.json?a=1",
  });
});

test("fetchDeployedBuild returns null for every failure shape", async () => {
  // Each of these is a real thing a phone sees, and none of them is an error worth
  // surfacing: they all mean "could not ask", which the UI renders as silence.
  const cases = {
    "404 on a host predating version.json": () => jsonResponse(null, false, 404),
    "500 from the origin":                  () => jsonResponse(null, false, 500),
    "network refused":                      () => { throw new Error("Failed to fetch"); },
    "captive portal serving HTML":          () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
    "json resolving to a non-object":       () => jsonResponse("not json"),
    "json resolving to null":               () => jsonResponse(null),
    "no response at all":                   () => undefined,
  };
  for (const [name, handler] of Object.entries(cases)) {
    const got = await fetchDeployedBuild({ fetchImpl: stubFetch(handler) });
    assert.equal(got, null, `${name} must yield null, not throw`);
  }
});

test("fetchDeployedBuild tolerates a payload missing fields", async () => {
  const got = await fetchDeployedBuild({ fetchImpl: stubFetch(() => jsonResponse({ commit: "9f8e7d6" })) });
  assert.deepEqual(got, { commit: "9f8e7d6", fullCommit: null, builtAt: null });
});

test("fetchDeployedBuild gives up rather than hanging forever", async () => {
  // A captive portal accepts the connection and never answers. Without the abort this
  // promise stays pending for the life of the page.
  const f = stubFetch((_url, opts) => new Promise((_resolve, reject) => {
    opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  const got = await fetchDeployedBuild({ fetchImpl: f, timeoutMs: 20 });
  assert.equal(got, null);
});

test("fetchDeployedBuild is a no-op with no fetch available", async () => {
  assert.equal(await fetchDeployedBuild({ fetchImpl: null }), null);
});

test("checkDeployedBuild combines config and network into one verdict", async () => {
  const f = stubFetch(() => jsonResponse({ commit: "9f8e7d6", builtAt: "2026-08-04T10:00:00.000Z" }));
  const r = await checkDeployedBuild({
    config: { BUILD_ID: "a1b2c3d", BUILT_AT: "2026-08-01T09:00:00.000Z" },
    fetchImpl: f,
  });
  assert.equal(r.status, "differs");
  assert.equal(r.loaded, "a1b2c3d");
  assert.equal(r.deployed, "9f8e7d6");
  assert.equal(r.builtAt, "2026-08-01T09:00:00.000Z");
  assert.equal(r.deployedBuiltAt, "2026-08-04T10:00:00.000Z");
});

test("checkDeployedBuild stays quiet when the probe fails", async () => {
  const r = await checkDeployedBuild({
    config: { BUILD_ID: "a1b2c3d" },
    fetchImpl: stubFetch(() => { throw new Error("offline"); }),
  });
  assert.equal(r.status, "unknown");
  assert.equal(r.deployed, null);
});

test("checkDeployedBuild survives being called with nothing at all", async () => {
  // The literal startup path on a browser with no fetch and no config: must not throw.
  const r = await checkDeployedBuild({ fetchImpl: null });
  assert.equal(r.status, "unknown");
});

test("describeBuildComparison names both commits when they differ", () => {
  const msg = describeBuildComparison(compareBuilds("a1b2c3d", "9f8e7d6"));
  assert.match(msg, /a1b2c3d/);
  assert.match(msg, /9f8e7d6/);
});

test("describeBuildComparison distinguishes 'cannot compare' from 'no build stamp'", () => {
  // Same "unknown" status, materially different situations: one is a deployed app that
  // could not reach the server, the other is a local copy that was never built.
  assert.match(describeBuildComparison(compareBuilds("a1b2c3d", null)), /could not reach/);
  assert.match(describeBuildComparison(compareBuilds(null, null)), /local or unbuilt/);
  assert.match(describeBuildComparison(compareBuilds("a1b2c3d", "a1b2c3d")), /Running the deployed build/);
  assert.equal(describeBuildComparison(null), "Build unknown.");
});
