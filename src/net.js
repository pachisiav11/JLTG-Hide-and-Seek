// Network resilience primitives (v2 Phase 4, items P and R).
//
// Two things, both shared by every proxy-backed loader (lines, stations, boundaries):
//
//   inFlight   — coalesce concurrent identical requests into one.
//   proxyBases — try more than one proxy before giving up.
//
// WHAT WAS ALREADY FINE, so that this module's scope is clear and nobody "fixes" it twice:
//
//   * Endpoint failover across public Overpass instances already exists, server-side, in
//     overpass.js — with a measured endpoint ORDER (maps.mail.ru 83%, overpass-api.de 28%,
//     kumi 0% over 61 live attempts) and a multi-pass budget. Nothing here duplicates that.
//   * Cache segmentation (§10.4 item Q) is already done: `lines` and `stations` are separate
//     IndexedDB stores with their own keys, a 30-day TTL, payload pruning, and a stale-cache
//     fallback when the network fails. That is the segmentation the reference achieves with
//     three named Cache Storage buckets.
//   * Simplifying a board polygon before putting it in a query (§10.4 item S) does not apply:
//     the proxy takes a BBOX, not a polygon, so there is no multi-kilobyte ring in the URL to
//     begin with. That is a better shape than the reference's, which inlines every vertex of
//     a hand-drawn board into every query.
//
// DOM-free and dependency-free so `node --test` can drive it.

// ---- Item R: in-flight de-duplication -----------------------------------

const _inFlight = new Map();

/**
 * Run `fn` under `key`, sharing the result with any caller that asks for the same key while
 * it is still running.
 *
 * The case this exists for: a board where several questions all need the same rail geometry.
 * Each loader independently missed the cache and issued its own identical request, so one
 * board setup could fire five copies of the same multi-second Overpass query — against a
 * volunteer-run service whose individual calls already fail ~64% of the time. Slower for the
 * player and rude to the upstream.
 *
 * Semantics that matter:
 *   - The entry is removed when the promise SETTLES, not when it resolves, so a failure does
 *     not poison the key forever. The next caller retries properly.
 *   - Rejections propagate to every sharer. They asked the same question; they get the same
 *     answer, including when the answer is an error.
 *   - Callers each get the same resolved VALUE, not a copy. Every consumer here treats loader
 *     results as read-only (they go straight into the cache and into geometry), so sharing is
 *     safe; a future mutating consumer must clone.
 */
export function dedupe(key, fn) {
  if (_inFlight.has(key)) return _inFlight.get(key);
  let p;
  try {
    p = Promise.resolve(fn());
  } catch (err) {
    // A synchronous throw must not leave a half-registered key behind.
    return Promise.reject(err);
  }
  const tracked = p.finally(() => {
    // Only clear if it is still OURS. A slow failure whose key was re-registered by a later
    // caller must not evict the newer in-flight request.
    if (_inFlight.get(key) === tracked) _inFlight.delete(key);
  });
  _inFlight.set(key, tracked);
  return tracked;
}

/** How many requests are currently in flight. Test/diagnostic use only. */
export function inFlightCount() {
  return _inFlight.size;
}

/** Drop all in-flight bookkeeping. Tests only — it does not cancel anything. */
export function resetInFlight() {
  _inFlight.clear();
}

// ---- Item P: more than one proxy ----------------------------------------

/**
 * Normalise whatever `OVERPASS_PROXY_URL` was configured as into a list of bases.
 *
 * Accepts a single string, a comma/whitespace-separated string, or an array, so an existing
 * one-proxy config keeps working untouched and a second can be added without a schema change.
 * Trailing slashes are stripped here so every caller can concatenate paths naively.
 */
export function proxyBases(configured) {
  const raw = Array.isArray(configured) ? configured : String(configured ?? "").split(/[,\s]+/);
  const out = [];
  for (const b of raw) {
    const s = String(b ?? "").trim().replace(/\/+$/, "");
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * A request against the first proxy base that answers, in order.
 *
 * `attempt(base)` performs one try and either resolves or throws. A thrown error carrying
 * `status` is inspected: a **4xx is fatal and stops the walk**, because a malformed query
 * fails identically on every proxy — retrying it burns the budget and then reports the wrong
 * cause ("all proxies down" when the truth is "this query is wrong"). That distinction is
 * already drawn server-side in overpass.js; this preserves it client-side rather than
 * flattening it.
 *
 * Everything else (network error, timeout, 5xx) is transient: try the next base.
 *
 * With one base configured this is exactly a single call, so nothing changes for an existing
 * deployment until a second base is added.
 */
export async function withProxyFailover(bases, attempt) {
  const list = proxyBases(bases);
  if (!list.length) throw new Error("No Overpass proxy configured (set OVERPASS_PROXY_URL in config.js).");

  let lastErr = null;
  for (const base of list) {
    try {
      return await attempt(base);
    } catch (err) {
      const status = err?.status;
      if (Number.isFinite(status) && status >= 400 && status < 500) throw err; // fatal, see above
      lastErr = err;
    }
  }
  // Report that EVERY base was tried. "Proxy failed" on a two-proxy setup reads as one
  // outage and sends someone to check the wrong thing.
  throw Object.assign(
    new Error(`All ${list.length} Overpass proxy${list.length === 1 ? "" : " endpoints"} failed: ${lastErr?.message || "unknown error"}`),
    { cause: lastErr, triedBases: list.length },
  );
}
