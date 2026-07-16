// Overpass transport: endpoint failover, busy-detection and backoff.
//
// Split out of server.js so it can be tested without starting an HTTP server. server.js
// keeps the route, the tag map and the response shaping; this module only knows how to get
// a JSON answer out of a flaky public API.

// Public Overpass endpoints, tried in order, several passes over the list.
//
// ORDER IS MEASURED, not arbitrary. Over 61 live attempts on 2026-07-15:
//   maps.mail.ru      15/18 (83%)
//   overpass-api.de    7/25 (28%)
//   overpass.kumi      0/18 ( 0%)
// The previous order tried the 0%-success endpoint SECOND and the 83% one LAST, so most
// requests walked the whole list before reaching the one that works. kumi is kept as a last
// resort rather than dropped — public instances recover, and a dead entry costs one attempt,
// whereas removing it leaves nothing when the other two are rate-limited.
export const OVERPASS_ENDPOINTS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Overall success across those attempts was 36% — i.e. ~64% of individual calls fail, worse
// than the ~50% previously assumed. Failures are transient and cleared on retry, so the
// budget is deliberately generous: several passes, multi-second waits. The old budget was
// 500ms then 1s across a SINGLE pass, an order of magnitude short of what a busy instance
// needs, after which the request failed for good.
export const OVERPASS_PASSES = 4;
export const OVERPASS_FETCH_TIMEOUT_MS = 45000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A busy Overpass instance has TWO failure shapes, and only one used to be caught:
//   1. HTTP 504 with an HTML body       — caught by the !resp.ok check.
//   2. HTTP 200 with an HTML error body — NOT caught. Overpass answers 200 and puts the
//      error in the payload ("Dispatcher_Client::request_read_and_idx::timeout. The server
//      is probably too busy to handle your request."). resp.ok is true, so it fell through
//      to resp.json() and threw `SyntaxError: Unexpected token '<'` — which reads like a
//      code defect in the log when the true cause is "the endpoint was busy, try again".
// Sniffing the body before parsing reports (and retries) a busy signal as what it is.
export function isBusyBody(text) {
  return !String(text).trimStart().startsWith("{");
}

// One attempt against one endpoint. Distinguishes fatal from transient:
//   400        -> our query is malformed. Never retry: it fails identically everywhere, so
//                 retrying burns the whole budget and then reports the wrong cause.
//   !ok / HTML -> the endpoint is busy. Transient; try the next one.
export async function tryOverpassOnce(url, query, { fetchImpl = fetch, timeoutMs = OVERPASS_FETCH_TIMEOUT_MS } = {}) {
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query),
    // fetch has NO default timeout: a stalled endpoint otherwise hangs forever while
    // looking like work in progress.
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();

  if (resp.status === 400) {
    const err = new Error(`Overpass rejected the query (HTTP 400): ${text.slice(0, 200).replace(/\s+/g, " ")}`);
    err.fatal = true;
    throw err;
  }
  if (!resp.ok) throw new Error(`busy: HTTP ${resp.status} from ${url}`);
  if (isBusyBody(text)) throw new Error(`busy: HTTP 200 with a non-JSON body from ${url} (endpoint overloaded)`);
  return JSON.parse(text);
}

// Try each endpoint in turn, several times over, with multi-second backoff between passes.
export async function runOverpass(query, {
  endpoints = OVERPASS_ENDPOINTS,
  passes = OVERPASS_PASSES,
  fetchImpl = fetch,
  timeoutMs = OVERPASS_FETCH_TIMEOUT_MS,
  betweenAttemptsMs = 1000,
  passBackoffMs = (pass) => 3000 * Math.pow(2, pass), // 3s, 6s, 12s
  onAttempt = null,
} = {}) {
  let lastErr;
  for (let pass = 0; pass < passes; pass++) {
    for (const url of endpoints) {
      try {
        const json = await tryOverpassOnce(url, query, { fetchImpl, timeoutMs });
        onAttempt?.({ url, pass, ok: true });
        return json;
      } catch (err) {
        onAttempt?.({ url, pass, ok: false, fatal: !!err.fatal, error: err.message });
        if (err.fatal) throw err; // a malformed query fails identically everywhere
        lastErr = err;
        if (betweenAttemptsMs) await sleep(betweenAttemptsMs);
      }
    }
    if (pass < passes - 1) await sleep(passBackoffMs(pass));
  }
  throw lastErr || new Error("no Overpass endpoints configured");
}
