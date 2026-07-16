// D3 — the Overpass proxy must recognise a busy endpoint instead of calling it a parse error.
//
// Measured on 2026-07-15 across ~61 live attempts: roughly 64% of individual calls fail.
// Two distinct shapes, and the second was invisible:
//   1. HTTP 504 with an HTML body       — caught by the !resp.ok check.
//   2. HTTP 200 with an HTML error body — NOT caught. resp.ok is true, so it fell through
//      to resp.json() and threw `SyntaxError: Unexpected token '<'`, which reads like a
//      code defect when the true cause is "the endpoint was busy, try again".
import { test } from "node:test";
import assert from "node:assert/strict";
import { runOverpass, isBusyBody, tryOverpassOnce, OVERPASS_ENDPOINTS } from "../overpass.js";

// The real HTTP-200 busy payload, verbatim from the spike.
const BUSY_HTML = `<!DOCTYPE html>
<html><head><title>OSM3S Response</title></head><body>
<p>The data included in this document is from www.openstreetmap.org.</p>
<p><strong style="color:#FF0000">Error</strong>: runtime error: open64: 0 Success /osm3s_osm_base
Dispatcher_Client::request_read_and_idx::timeout. The server is probably too busy to handle your request.</p>
</body></html>`;

const okJson = JSON.stringify({ elements: [{ type: "node", lat: 19.07, lon: 72.87, tags: { name: "X" } }] });

// Minimal fetch stand-in. `script` is consumed one response per attempt.
function fakeFetch(script) {
  const calls = [];
  const impl = async (url) => {
    const next = script.shift();
    calls.push(url);
    if (!next) throw new Error("fakeFetch: script exhausted");
    if (next.networkError) throw new Error(next.networkError);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.body,
    };
  };
  impl.calls = calls;
  return impl;
}

// Fast timings so tests don't sit through the real multi-second backoff.
const fast = { betweenAttemptsMs: 0, passBackoffMs: () => 0 };

test("isBusyBody spots an HTML payload and passes real JSON", () => {
  assert.equal(isBusyBody(BUSY_HTML), true, "an HTML error page is a busy signal");
  assert.equal(isBusyBody(okJson), false, "real JSON is not busy");
  assert.equal(isBusyBody('  {"elements":[]}'), false, "leading whitespace is fine");
});

test("HTTP 200 with an HTML body is treated as BUSY, not a parse error", async () => {
  // The regression. Old code: resp.ok true -> resp.json() -> SyntaxError: Unexpected token '<'.
  const fetchImpl = fakeFetch([{ status: 200, body: BUSY_HTML }, { status: 200, body: okJson }]);
  const attempts = [];
  const json = await runOverpass("q", { fetchImpl, ...fast, onAttempt: (a) => attempts.push(a) });

  assert.deepEqual(json.elements.length, 1, "should recover on the next endpoint");
  assert.match(attempts[0].error, /busy/i, "the failure must be reported as busy...");
  // The old log said `Unexpected token '<'`, which reads like a code defect and would
  // genuinely mislead anyone debugging this from the log alone in six months.
  assert.doesNotMatch(attempts[0].error, /Unexpected token|SyntaxError/i, "...never as a parse error");
  assert.match(attempts[0].error, /overloaded|busy/i, "and should name the real cause");
});

test("HTTP 504 with an HTML body is also busy, and also recovers", async () => {
  const fetchImpl = fakeFetch([{ status: 504, body: "<html>gateway timeout</html>" }, { status: 200, body: okJson }]);
  const json = await runOverpass("q", { fetchImpl, ...fast });
  assert.equal(json.elements.length, 1);
});

test("tries the measured-most-reliable endpoint FIRST", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: okJson }]);
  await runOverpass("q", { fetchImpl, ...fast });
  // maps.mail.ru measured 15/18; the old order put it last, behind an endpoint at 0/18.
  assert.match(fetchImpl.calls[0], /maps\.mail\.ru/);
  assert.match(OVERPASS_ENDPOINTS[0], /maps\.mail\.ru/);
  assert.match(OVERPASS_ENDPOINTS[OVERPASS_ENDPOINTS.length - 1], /kumi/, "the 0/18 endpoint is last resort");
});

test("makes several passes over the endpoint list, not one", async () => {
  // Every endpoint busy on pass 1, then the first endpoint recovers on pass 2. The old
  // single-pass budget gave up here and failed the request for good.
  const script = [
    { status: 200, body: BUSY_HTML }, { status: 504, body: "<html/>" }, { status: 200, body: BUSY_HTML },
    { status: 200, body: okJson },
  ];
  const fetchImpl = fakeFetch(script);
  const json = await runOverpass("q", { fetchImpl, ...fast });
  assert.equal(json.elements.length, 1);
  assert.equal(fetchImpl.calls.length, 4, "3 endpoints on pass 1, then success on pass 2");
});

test("gives up only after every pass, and reports 'busy' rather than a parse error", async () => {
  const script = Array.from({ length: 12 }, () => ({ status: 200, body: BUSY_HTML })); // 3 endpoints x 4 passes
  const fetchImpl = fakeFetch(script);
  await assert.rejects(
    () => runOverpass("q", { fetchImpl, ...fast }),
    (e) => /busy/i.test(e.message) && !/Unexpected token/.test(e.message),
  );
  assert.equal(fetchImpl.calls.length, 12, "4 passes over 3 endpoints");
});

test("HTTP 400 is FATAL — never retried across endpoints", async () => {
  // A malformed query fails identically everywhere. Retrying it burns the whole budget and
  // then blames an outage. (The earlier spike lost a run to exactly this: a bad query was
  // retried 15 times as though it were 'busy'.)
  const fetchImpl = fakeFetch(Array.from({ length: 12 }, () => ({ status: 400, body: "line 2: parse error" })));
  await assert.rejects(
    () => runOverpass("q", { fetchImpl, ...fast }),
    (e) => e.fatal === true && /rejected the query/i.test(e.message),
  );
  assert.equal(fetchImpl.calls.length, 1, "must abort on the first 400, not walk the list");
});

test("a network error is transient and moves to the next endpoint", async () => {
  const fetchImpl = fakeFetch([{ networkError: "ECONNRESET" }, { status: 200, body: okJson }]);
  const json = await runOverpass("q", { fetchImpl, ...fast });
  assert.equal(json.elements.length, 1);
});

test("tryOverpassOnce passes a timeout signal (fetch has no default)", async () => {
  // A stalled endpoint otherwise hangs forever while looking like work in progress — this
  // cost the spike a run that produced one log line in 100 seconds.
  let seenSignal;
  const fetchImpl = async (_url, opts) => {
    seenSignal = opts.signal;
    return { ok: true, status: 200, text: async () => okJson };
  };
  await tryOverpassOnce("http://x", "q", { fetchImpl, timeoutMs: 1234 });
  assert.ok(seenSignal, "an AbortSignal must be supplied");
  assert.equal(typeof seenSignal.aborted, "boolean");
});
