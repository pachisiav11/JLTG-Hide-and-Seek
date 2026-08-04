// v2 Phase 4, items P and R — in-flight de-duplication and multi-proxy failover.
//
// Both exist for the same underlying fact: Overpass is a volunteer-run service where roughly
// 64% of individual calls fail (measured over 61 live attempts, see overpass.js). Everything
// this app does against it has to assume flakiness.
//
// R is the cheaper win. A board where several questions need the same rail geometry used to
// issue several identical multi-second queries, because each loader independently missed the
// cache. Slower for the player and rude to the upstream.
//
// P is the gap the reference mapper does better than us today: it ships three Overpass hosts
// with automatic fallback, and we had exactly one proxy base with nothing behind it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupe, inFlightCount, resetInFlight, proxyBases, withProxyFailover } from "../src/net.js";

const defer = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// ---- Item R: de-duplication ---------------------------------------------

test("concurrent callers with the same key share one call", async () => {
  resetInFlight();
  let calls = 0;
  const d = defer();
  const fn = () => { calls++; return d.promise; };

  const a = dedupe("k", fn);
  const b = dedupe("k", fn);
  const c = dedupe("k", fn);
  assert.equal(calls, 1, "the work must run once");
  assert.equal(inFlightCount(), 1);

  d.resolve("payload");
  assert.deepEqual(await Promise.all([a, b, c]), ["payload", "payload", "payload"]);
  assert.equal(inFlightCount(), 0, "the key is released once it settles");
});

test("different keys do not share", async () => {
  resetInFlight();
  let calls = 0;
  await Promise.all([
    dedupe("a", () => { calls++; return Promise.resolve(1); }),
    dedupe("b", () => { calls++; return Promise.resolve(2); }),
  ]);
  assert.equal(calls, 2);
});

// The failure that makes a naive implementation worse than none: caching the rejected
// promise means one transient Overpass failure poisons that query for the rest of the
// session, and the player sees a permanent error where a retry would have worked.
test("a failure is shared by current waiters but does NOT poison the key", async () => {
  resetInFlight();
  let calls = 0;
  const d1 = defer();
  const p1 = dedupe("k", () => { calls++; return d1.promise; });
  const p2 = dedupe("k", () => { calls++; return d1.promise; });
  d1.reject(new Error("overpass busy"));

  await assert.rejects(p1, /overpass busy/);
  await assert.rejects(p2, /overpass busy/, "everyone who asked gets the same answer, error included");
  assert.equal(calls, 1);

  // The next caller must genuinely retry.
  const again = await dedupe("k", () => { calls++; return Promise.resolve("ok"); });
  assert.equal(again, "ok");
  assert.equal(calls, 2, "a settled failure must not be cached");
});

test("a caller arriving after the first has settled starts a fresh call", async () => {
  resetInFlight();
  let calls = 0;
  const fn = () => { calls++; return Promise.resolve(calls); };
  assert.equal(await dedupe("k", fn), 1);
  assert.equal(await dedupe("k", fn), 2, "de-duplication is for CONCURRENT callers, not a cache");
});

test("a synchronous throw rejects without leaving the key registered", async () => {
  resetInFlight();
  await assert.rejects(dedupe("k", () => { throw new Error("boom"); }), /boom/);
  assert.equal(inFlightCount(), 0, "a half-registered key would deadlock every later caller");
});

// ---- Item P: proxy bases ------------------------------------------------

test("proxyBases accepts a single string, a list, or an array", () => {
  assert.deepEqual(proxyBases("https://a.example"), ["https://a.example"]);
  assert.deepEqual(proxyBases("https://a.example, https://b.example"), ["https://a.example", "https://b.example"]);
  assert.deepEqual(proxyBases(["https://a.example", "https://b.example"]), ["https://a.example", "https://b.example"]);
});

test("proxyBases strips trailing slashes and de-duplicates", () => {
  assert.deepEqual(
    proxyBases("https://a.example/, https://a.example, https://b.example//"),
    ["https://a.example", "https://b.example"],
  );
});

test("proxyBases tolerates nothing configured", () => {
  for (const v of [null, undefined, "", "  ", []]) assert.deepEqual(proxyBases(v), []);
});

test("failover returns the first base that answers", async () => {
  const tried = [];
  const out = await withProxyFailover("https://a.example,https://b.example", async (base) => {
    tried.push(base);
    if (base.includes("a.")) throw new Error("down");
    return `from ${base}`;
  });
  assert.equal(out, "from https://b.example");
  assert.deepEqual(tried, ["https://a.example", "https://b.example"]);
});

test("a single configured base behaves exactly like one call", async () => {
  const tried = [];
  const out = await withProxyFailover("https://only.example", async (b) => { tried.push(b); return "ok"; });
  assert.equal(out, "ok");
  assert.equal(tried.length, 1, "an existing one-proxy deployment must not change behaviour");
});

// The distinction the server already draws and the client must not flatten. A malformed
// query fails identically everywhere: walking the whole list burns the budget and then
// reports "all proxies down", sending someone to check an outage that isn't happening.
test("a 4xx is fatal and stops the walk", async () => {
  const tried = [];
  await assert.rejects(
    withProxyFailover("https://a.example,https://b.example", async (base) => {
      tried.push(base);
      throw Object.assign(new Error("bad query"), { status: 400 });
    }),
    /bad query/,
  );
  assert.deepEqual(tried, ["https://a.example"], "a client error must not be retried elsewhere");
});

test("a 5xx is transient and moves on to the next base", async () => {
  const tried = [];
  const out = await withProxyFailover("https://a.example,https://b.example", async (base) => {
    tried.push(base);
    if (base.includes("a.")) throw Object.assign(new Error("all endpoints busy"), { status: 502 });
    return "ok";
  });
  assert.equal(out, "ok");
  assert.equal(tried.length, 2);
});

test("when every base fails the error says how many were tried", async () => {
  // "Proxy failed" on a two-proxy setup reads as one outage and misdirects the diagnosis.
  await assert.rejects(
    withProxyFailover("https://a.example,https://b.example", async () => { throw new Error("network down"); }),
    (err) => {
      assert.match(err.message, /All 2 Overpass proxy endpoints failed/);
      assert.match(err.message, /network down/, "the underlying cause must survive");
      assert.equal(err.triedBases, 2);
      return true;
    },
  );
});

test("no proxy configured says so, rather than reporting a network failure", async () => {
  await assert.rejects(
    withProxyFailover("", async () => "unreachable"),
    /No Overpass proxy configured/,
  );
});
