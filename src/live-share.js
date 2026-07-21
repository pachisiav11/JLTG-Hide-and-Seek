// Phase 12 (§C5): live seeker→hider location share + close-approach alert.
//
// Rolls back part of the "no online multiplayer" non-goal from PLAYTEST_IDEAS
// at the user's request (2026-07-20): a narrow one-way channel carrying only
// coordinates, not game state, from a session's seeker device to a session's
// hider device. Full state sync stays out of scope. The rest of the app is
// unchanged.
//
// Why: after Phase 5's paste intake landed, the hider still had no LIVE view
// of where the seekers were — every paste is a snapshot, always stale by the
// time it's read. This closes that gap without reviving the Phase-13 full
// relay. The hider's device automatically compares the seeker's live point to
// the Hider zone centre every update and fires a system notification (via the
// Phase 9 SW path) when the distance drops below a threshold.

import * as store from "./store.js";
import { getPalette } from "./palette.js";

// Pure decision function: given a seeker point + a hider's zone centre +
// threshold, decide whether a close-approach alert is due. Prior state carries
// last-inside status so we only fire on the "outside → inside" transition —
// once per crossing, not every 60 s while the seeker parks nearby (per user
// 2026-07-20).
//
// Two guard layers on the way in, kept separate on purpose. A missing point
// (`!seekerPoint || !zoneCentre`) is genuine "no signal" and returns a null-ish
// state — the caller has nothing to render. But a `thresholdM <= 0` picks the
// user-visible "Off (pin only)" mode from the live-share settings sheet: they
// still want the distance in the pill, just no crossing alert. Bundling those
// two guards used to null out the state either way, and `_onSeekerPing` then
// dereferenced `out.state.distance` on the first pin-only ping and threw.
export function evaluateApproach({ seekerPoint, zoneCentre, thresholdM, prior, now = Date.now() }) {
  if (!seekerPoint || !zoneCentre) return { state: prior || null, notify: null };
  const R = 6371000;
  const lat0 = ((seekerPoint.lat + zoneCentre.lat) / 2) * Math.PI / 180;
  const dLat = ((zoneCentre.lat - seekerPoint.lat) * Math.PI) / 180;
  const dLng = ((zoneCentre.lng - seekerPoint.lng) * Math.PI / 180) * Math.cos(lat0);
  const d = R * Math.hypot(dLat, dLng);
  // Pin-only mode: return distance for the pill but never signal a crossing.
  if (!(thresholdM > 0)) return { state: { inside: false, distance: d, at: now }, notify: null };
  const inside = d < thresholdM;
  const wasInside = !!prior?.inside;
  const state = { inside, distance: d, at: now };
  if (inside && !wasInside) {
    const km = d / 1000;
    const label = km >= 1 ? `${km.toFixed(2)} km` : `${Math.round(d)} m`;
    return {
      state,
      notify: {
        kind: "seeker-close",
        title: "Seeker close",
        body: `A seeker is ~${label} from your hiding zone centre.`,
      },
    };
  }
  return { state, notify: null };
}

// Session code generator — 6-char alphanumeric, human-readable, no ambiguous
// characters (0/O, 1/I/L). The two players exchange this out of band; the
// relay uses it as a room name.
export function generateSessionCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// Client wrapper. Transport is pluggable so tests can inject an in-memory
// event bus without opening a socket. Production callers construct a
// SocketIOTransport from the loaded socket.io-client global.
export class LiveShare {
  constructor({ transport, geolocation = (typeof navigator !== "undefined" ? navigator.geolocation : null), Notification = (typeof window !== "undefined" ? window.Notification : null) } = {}) {
    this.transport = transport;
    this.geolocation = geolocation;
    this.N = Notification;
    this.role = null;
    this.code = null;
    this.approachState = null;
    this._publishTimer = null;
    this._watchId = null;
    this._locationHandler = null;
    this._pill = null;
    this._lastSeekerPoint = null;
  }

  // Seeker side. Publishes GPS every ~60 s to the room named by `code`.
  startAsSeeker(code) {
    this._teardown();
    this.role = "seeker";
    this.code = code;
    this.transport?.emit?.("join-session", { code, role: "seeker" });
    this._ensurePill();
    // Publish immediately, then every 60 s. `enableHighAccuracy` on the
    // watch mirrors what the geofence does; the two features share the GPS
    // subscription cost in practice.
    const publish = () => {
      if (!this.geolocation?.getCurrentPosition) return;
      this.geolocation.getCurrentPosition(
        (p) => {
          const point = { lat: p.coords.latitude, lng: p.coords.longitude };
          this.transport?.emit?.("share-location", point);
          this._writePill(`Sharing · ${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`);
        },
        (err) => { console.warn("live-share seeker: geolocation error", err); this._writePill("Location unavailable"); },
        { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 },
      );
    };
    publish();
    this._publishTimer = setInterval(publish, 60_000);
  }

  // Hider side. Subscribes to the room and evaluates every incoming ping
  // against the current Hider zone centre.
  startAsHider(code) {
    this._teardown();
    this.role = "hider";
    this.code = code;
    this.transport?.emit?.("join-session", { code, role: "hider" });
    this._locationHandler = (payload) => this._onSeekerPing(payload);
    this.transport?.on?.("location", this._locationHandler);
    this._ensurePill();
    this._writePill("Waiting for a seeker ping…");
  }

  _onSeekerPing(payload) {
    if (!payload || !Number.isFinite(payload.lat) || !Number.isFinite(payload.lng)) return;
    this._lastSeekerPoint = { lat: payload.lat, lng: payload.lng, at: payload.at || Date.now() };
    const g = store.getCurrent();
    const centre = g?.focusZone?.point;
    const threshold = Number(g?.settings?.approachThresholdM) || 0;
    if (!centre) {
      this._writePill(`Seeker @ ${payload.lat.toFixed(4)}, ${payload.lng.toFixed(4)} · no hider zone`);
      return;
    }
    const out = evaluateApproach({ seekerPoint: this._lastSeekerPoint, zoneCentre: centre, thresholdM: threshold, prior: this.approachState });
    this.approachState = out.state;
    const d = out.state.distance;
    const label = d >= 1000 ? `${(d / 1000).toFixed(2)} km` : `${Math.round(d)} m`;
    this._writePill(`Seeker ${label} from zone${threshold ? ` (alert < ${threshold >= 1000 ? (threshold / 1000).toFixed(1) + " km" : threshold + " m"})` : ""}`);
    if (out.notify) this._fireNotification(out.notify);
  }

  _fireNotification({ title, body }) {
    if (!this.N || this.N.permission !== "granted") return;
    // Same SW-first path Phase 9 introduced for geofence — a backgrounded
    // hider tab still gets a system-tray alert.
    const payload = { type: "GEOFENCE_NOTIFY", title, body, tag: "jltg-seeker-close" };
    try {
      const sw = typeof navigator !== "undefined" && navigator.serviceWorker;
      const controller = sw?.controller;
      if (controller) return controller.postMessage(payload);
      if (sw?.ready?.then) return sw.ready.then((reg) => reg.active?.postMessage(payload));
    } catch (_) { /* fall through */ }
    try { new this.N(title, { body, tag: "jltg-seeker-close", renotify: true }); }
    catch (e) { console.warn("live-share notification failed", e); }
  }

  stop() { this._teardown(); this._removePill(); this.role = null; this.code = null; }

  _teardown() {
    if (this._publishTimer) { clearInterval(this._publishTimer); this._publishTimer = null; }
    if (this._locationHandler) { try { this.transport?.off?.("location", this._locationHandler); } catch (_) {} this._locationHandler = null; }
    this._lastSeekerPoint = null;
    this.approachState = null;
  }

  _ensurePill() {
    if (this._pill) return;
    if (typeof document === "undefined" || typeof document.createElement !== "function" || typeof document.body?.appendChild !== "function") return;
    const el = document.createElement("div");
    el.id = "live-share-pill";
    el.className = "live-share-pill";
    el.textContent = "";
    document.body.appendChild(el);
    this._pill = el;
  }
  _removePill() { this._pill?.remove(); this._pill = null; }
  _writePill(text) { if (this._pill) this._pill.textContent = text; }
}
