// Phase 18 (fix #6): server-side validator for the seeker→hider location relay.
//
// Kept in its own file (not on server.js) so the test can import and pin it
// without booting the HTTP + Socket.IO listener that server.js starts at
// module top level.
//
// Silent drop is deliberate: the relay never surfaces bad clients to the good
// hider. A misbehaving seeker (or a buggy geolocation stub returning a
// sentinel like 9999) would otherwise get rebroadcast, the hider's distance
// formula would produce nonsense, and their pill would read "Seeker 1500.28
// km from zone". Rejecting on the server keeps that garbage off the wire.

export function isValidLocationPayload(payload) {
  if (!payload || !Number.isFinite(payload.lat) || !Number.isFinite(payload.lng)) return false;
  if (payload.lat < -90 || payload.lat > 90) return false;
  if (payload.lng < -180 || payload.lng > 180) return false;
  return true;
}

// Phase 19 (fix #7): token-bucket rate limit on the share-location relay.
//
// The natural seeker cadence per Phase 12 is one publish every 60 s. But a
// bad or malicious client can publish as fast as it likes; each ping is
// rebroadcast to the hider and, if its coordinates jitter across the
// close-approach threshold, defeats Phase 12's once-per-crossing debounce
// entirely (alert spam). This function throttles per-socket to a sustained
// 4 pings/second with a 6-token burst allowance, silently dropping the rest.
//
// Bucket lives on the socket via `socket.data` (Socket.IO's per-connection
// scratch space); each connection gets its own state, so a slow seeker never
// affects a fast one. Extracted here (not in server.js) so tests can exercise
// the throttle without booting the listener.
const BURST_CAPACITY = 6;
const REFILL_INTERVAL_MS = 250; // 1 token per 250 ms → 4/s sustained

export function allowShareLocation(state, now = Date.now()) {
  if (!state.rateBucket) state.rateBucket = { tokens: BURST_CAPACITY, lastRefill: now };
  const b = state.rateBucket;
  const elapsed = now - b.lastRefill;
  if (elapsed > 0) {
    b.tokens = Math.min(BURST_CAPACITY, b.tokens + elapsed / REFILL_INTERVAL_MS);
    b.lastRefill = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
