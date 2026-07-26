// Phase 43 (Track B 2/3): the hider FCM-token registry.
//
// Kept in its own file (not on server.js) so a test can import and pin it
// without booting the HTTP + Socket.IO listener that server.js starts at module
// top level — the same discipline as share-location.js.
//
// The seeker-close alert must reach a hider whose phone is LOCKED, which the
// socket path can't do (a backgrounded WebView is suspended in Doze). Phase 44
// forwards each seeker ping to the hider as a high-priority FCM message instead;
// for that, the server needs to know the hider's FCM device token, keyed by the
// session code the two players already exchange. This registry is that map.
//
// It stays true to the relay's founding principle — NO game state on the server.
// A token is an opaque delivery address, not a location or a zone; the server
// still never learns where anyone is or where the hiding zone sits (Phase 44 has
// the hider's own phone do the distance maths). Entries expire so a hider who
// closes the app without a clean disconnect doesn't leave a token that the server
// keeps trying to push to forever.

// FCM registration tokens are long opaque strings. We don't pin the exact format
// (it has changed across FCM versions) — just reject the obvious junk so a
// mistyped/empty value can't occupy a session slot.
export function isValidToken(token) {
  if (typeof token !== "string") return false;
  const t = token.trim();
  return t.length >= 20 && t.length <= 4096 && /^[A-Za-z0-9_:.\-]+$/.test(t);
}

// Session codes match the relay's room rule (server.js join-session).
export function normalizeCode(code) {
  const c = typeof code === "string" ? code.trim().toLowerCase() : "";
  return /^[a-z0-9-]{3,32}$/.test(c) ? c : null;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 h — comfortably longer than a game.

export class HiderTokenRegistry {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this._ttlMs = ttlMs;
    this._now = now;
    this._byCode = new Map(); // code -> { token, at }
    // Phase 51: the hider's zone centre + threshold + alert style, so the
    // SERVER can decide the seeker-close crossing itself and send a real FCM
    // *notification* (not just data) — one Android displays even if the app
    // process is fully dead, unlike the data-only message a locked-but-alive
    // WebView needs to wake up and compute the same thing on its own. This is
    // a deliberate, narrow exception to "the relay is zone-blind": a hider's
    // zone centre + a distance threshold, nothing else, session-scoped and
    // TTL'd exactly like the token above.
    this._zoneByCode = new Map();     // code -> { point:{lat,lng}, thresholdM, alertStyle, at }
    this._approachByCode = new Map(); // code -> evaluateApproach's prior state (edge-triggered crossing baseline)
  }

  get size() { return this._byCode.size; }

  // Register (or refresh) the hider token for a session. Returns true on success,
  // false if the code or token is invalid (the caller can log/ignore).
  register(code, token) {
    const c = normalizeCode(code);
    if (!c || !isValidToken(token)) return false;
    this._byCode.set(c, { token: token.trim(), at: this._now() });
    return true;
  }

  // Look up a live (non-expired) token for a session, or null. Expired entries
  // are dropped lazily on read so a stale token is never handed to a sender.
  lookup(code) {
    const c = normalizeCode(code);
    if (!c) return null;
    const entry = this._byCode.get(c);
    if (!entry) return null;
    if (this._now() - entry.at > this._ttlMs) { this._byCode.delete(c); return null; }
    return entry.token;
  }

  // Remove a session's token (clean disconnect, or a send that came back
  // "token not registered" in Phase 44). Only drops when the stored token
  // matches, so a late disconnect from an old socket can't evict a token a
  // reconnected hider just refreshed.
  drop(code, token = null) {
    const c = normalizeCode(code);
    if (!c) return false;
    if (token != null) {
      const entry = this._byCode.get(c);
      if (!entry || entry.token !== String(token).trim()) return false;
    }
    return this._byCode.delete(c);
  }

  // Register (or refresh) the hider's zone centre + threshold + alert style
  // for the server-side crossing check. Returns true on success, false for an
  // invalid code/point/threshold. A geometry CHANGE (moved zone, edited
  // threshold) resets the crossing baseline so the next ping establishes it
  // silently instead of firing a spurious transition against the old zone —
  // the same rule native-geofence.js's zoneKey() applies on-device.
  registerZone(code, { point, thresholdM, alertStyle } = {}) {
    const c = normalizeCode(code);
    if (!c) return false;
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return false;
    if (point.lat < -90 || point.lat > 90 || point.lng < -180 || point.lng > 180) return false;
    const t = Number(thresholdM);
    if (!Number.isFinite(t) || t < 0) return false;
    const style = typeof alertStyle === "string" ? alertStyle : "vibrate-tone";
    const prevKey = this._zoneKeyFor(c);
    const nextKey = `${point.lat.toFixed(6)},${point.lng.toFixed(6)}|${t}`;
    this._zoneByCode.set(c, { point: { lat: point.lat, lng: point.lng }, thresholdM: t, alertStyle: style, at: this._now() });
    if (prevKey !== nextKey) this._approachByCode.delete(c);
    return true;
  }

  _zoneKeyFor(code) {
    const e = this._zoneByCode.get(code);
    return e ? `${e.point.lat.toFixed(6)},${e.point.lng.toFixed(6)}|${e.thresholdM}` : null;
  }

  // Look up a live (non-expired) zone for a session, or null.
  lookupZone(code) {
    const c = normalizeCode(code);
    if (!c) return null;
    const entry = this._zoneByCode.get(c);
    if (!entry) return null;
    if (this._now() - entry.at > this._ttlMs) { this._zoneByCode.delete(c); this._approachByCode.delete(c); return null; }
    return { point: entry.point, thresholdM: entry.thresholdM, alertStyle: entry.alertStyle };
  }

  // The prior evaluateApproach state for a session's crossing detector, or
  // null (no baseline yet / never set).
  getApproachState(code) {
    const c = normalizeCode(code);
    return c ? (this._approachByCode.get(c) || null) : null;
  }
  setApproachState(code, state) {
    const c = normalizeCode(code);
    if (c) this._approachByCode.set(c, state);
  }

  // Drop a session's zone + crossing baseline (clean disconnect).
  dropZone(code) {
    const c = normalizeCode(code);
    if (!c) return false;
    this._approachByCode.delete(c);
    return this._zoneByCode.delete(c);
  }

  // Sweep expired entries. Cheap to call on a timer; also runs lazily in lookup.
  prune() {
    const cutoff = this._now() - this._ttlMs;
    let removed = 0;
    for (const [c, entry] of this._byCode) {
      if (entry.at < cutoff) { this._byCode.delete(c); removed++; }
    }
    for (const [c, entry] of this._zoneByCode) {
      if (entry.at < cutoff) { this._zoneByCode.delete(c); this._approachByCode.delete(c); removed++; }
    }
    return removed;
  }
}
