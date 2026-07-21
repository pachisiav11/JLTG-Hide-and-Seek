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
