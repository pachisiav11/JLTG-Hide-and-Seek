// Phase 40 (Stage 6): the real-phone Doze SPIKE.
//
// BUILD_PLAN_2026-07-21.md gates the whole native background track on one
// question that cannot be answered from a desk: when an Android phone is
// LOCKED, STATIONARY and SCREEN-OFF long enough to enter Doze, does a FREE
// background-location plugin keep delivering fixes — and can we fire a
// notification off one — or does the OS suspend it? The answer picks the
// architecture for Phases 41-44:
//
//   - PASS  → the community background-geolocation foreground service survives
//             Doze; the hider geofence can ride it (compute band in JS, notify).
//   - FAIL  → the foreground service is throttled in Doze; the hider MUST use
//             native OS geofencing (GeofencingClient fires a BroadcastReceiver
//             even in Doze) and the seeker path MUST use high-priority FCM.
//
// This module IS that experiment, not a shipped feature. It is inert unless the
// URL hash is `#bgspike` AND we're inside the Capacitor native shell — it never
// touches a normal web/PWA boot. It:
//   1. opens the community plugin's background watcher (a foreground service, so
//      the process stays alive with a persistent notification),
//   2. stamps every fix with wall-clock time and PERSISTS the log to
//      localStorage (so a Doze-kill of the WebView can't erase the evidence —
//      on relaunch we still see whether fixes kept coming),
//   3. drops a geofence at a tapped point and, reusing the SAME evaluateGeofence
//      band machine the real hider uses, fires a LocalNotification (stamped with
//      the time) on each band crossing,
//   4. reduces the fix log to a verdict from the inter-fix GAPS: a gap many
//      times the requested cadence means the OS suspended the plugin.
//
// The pure helpers (normalize/gap/summary/verdict/zone) are exported and unit-
// tested headlessly; only the wiring below needs a device.

import { evaluateGeofence } from "./geofence.js";

// localStorage keys. The log survives a WebView restart on purpose — that's the
// whole point of a Doze test: prove fixes kept arriving while we couldn't watch.
const LOG_KEY = "jltg.bgspike.log";
const CFG_KEY = "jltg.bgspike.cfg";
const MAX_ROWS = 800; // ~a full night at 30 s cadence; trims oldest beyond this.

// True only inside the Capacitor native shell. The native bridge injects
// window.Capacitor with isNativePlatform()/registerPlugin(); a plain browser or
// PWA has neither, so the spike stays completely inert there.
export function isNativeCapacitor() {
  const c = typeof window !== "undefined" && window.Capacitor;
  return !!(c && typeof c.isNativePlatform === "function" && c.isNativePlatform());
}

// --- Pure helpers (headless-testable, no DOM, no Capacitor) ---------------

// The community plugin hands back {latitude, longitude, accuracy, time, ...};
// getCurrentPosition-style callers use {lat, lng}. Normalize to our shape and
// reject a fix without finite coordinates (an error tick, not a location).
export function normalizeLocation(loc) {
  if (!loc) return null;
  const lat = loc.latitude != null ? loc.latitude : loc.lat;
  const lng = loc.longitude != null ? loc.longitude : loc.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    accuracy: Number.isFinite(loc.accuracy) ? loc.accuracy : null,
    at: Number.isFinite(loc.time) ? loc.time : Date.now(),
  };
}

// Milliseconds between two fixes, or null if either timestamp is missing. Never
// negative (a clock hiccup or out-of-order delivery clamps to 0).
export function fixGapMs(prev, next) {
  if (!prev || !next || !(prev.at > 0) || !(next.at > 0)) return null;
  return Math.max(0, next.at - prev.at);
}

// A geofence centred on a fix, for "set the zone where I'm standing".
export function spikeZoneFromFix(fix, { radius = 150 } = {}) {
  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return null;
  return { point: { lat: fix.lat, lng: fix.lng }, radius };
}

// Reduce a run of log rows to the numbers the verdict is made of. The signal is
// the inter-fix GAP distribution: steady = plugin ran; one huge gap = suspended.
export function summarizeSpikeLog(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const fixes = list.filter((r) => r && r.type === "fix");
  const gaps = [];
  for (let i = 1; i < fixes.length; i++) {
    const g = fixGapMs(fixes[i - 1], fixes[i]);
    if (g != null) gaps.push(g);
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const max = sorted.length ? sorted[sorted.length - 1] : null;
  return {
    fixCount: fixes.length,
    notifyCount: list.filter((r) => r && r.type === "notify").length,
    errorCount: list.filter((r) => r && r.type === "error").length,
    maxGapMs: max,
    medianGapMs: median,
    firstAt: fixes.length ? fixes[0].at : null,
    lastAt: fixes.length ? fixes[fixes.length - 1].at : null,
  };
}

// The conclusive call. The spike passes only if fixes kept arriving through the
// run with no gap far beyond the requested cadence. `expectedIntervalMs` is what
// we asked the plugin for; `tolerance` is how many intervals we forgive before
// calling it a suspension (GPS jitter + one missed fix is normal; a 4x gap is
// the OS parking the service). A pass means the free foreground-service path is
// Doze-proof enough for the hider geofence; a fail sends Phase 41 to native OS
// geofencing + FCM instead.
export function spikeVerdict(summary, { expectedIntervalMs = 30000, tolerance = 4, minFixes = 3 } = {}) {
  if (!summary || !summary.fixCount) {
    return { pass: false, reason: "No fixes recorded — the plugin never delivered a location. Check permissions / that the watcher started." };
  }
  if (summary.fixCount < minFixes) {
    return { pass: false, reason: `Only ${summary.fixCount} fix(es) — too few to judge. Let it run longer through the Doze window.` };
  }
  const ceilingMs = expectedIntervalMs * tolerance;
  if (summary.maxGapMs != null && summary.maxGapMs > ceilingMs) {
    return {
      pass: false,
      reason: `Largest gap ${Math.round(summary.maxGapMs / 1000)}s exceeds the ${Math.round(ceilingMs / 1000)}s ceiling — the plugin was SUSPENDED (Doze). The free foreground-service path is NOT Doze-proof; Phase 41 must use OS geofencing + FCM.`,
    };
  }
  return {
    pass: true,
    reason: `${summary.fixCount} fixes, largest gap ${Math.round((summary.maxGapMs || 0) / 1000)}s (≤ ${Math.round(ceilingMs / 1000)}s ceiling) — the plugin kept running through the run. The free foreground-service path SURVIVED; the hider geofence can ride it.`,
  };
}

// --- localStorage-backed log ----------------------------------------------

function loadLog() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveLog(rows) {
  try {
    const trimmed = rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows;
    localStorage.setItem(LOG_KEY, JSON.stringify(trimmed));
  } catch { /* quota / private mode — the in-memory copy still drives the UI */ }
}
function loadCfg() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveCfg(cfg) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

// --- The on-device spike harness (needs the native shell) -----------------

class BgSpike {
  constructor() {
    this.cap = window.Capacitor;
    this.BG = null;
    this.LN = null;
    // The remote-loaded live site never bundles @capacitor/core, so the native
    // bridge object only has isNativePlatform()/getPlatform() — registerPlugin()
    // is added by @capacitor/core's own module init. Fetch it lazily (only once
    // the spike actually activates) rather than paying for it on every page load.
    this._pluginsReady = import("../vendor/capacitor-core.js").then(({ registerPlugin }) => {
      this.BG = registerPlugin("BackgroundGeolocation");
      this.LN = registerPlugin("LocalNotifications");
    });
    this.rows = loadLog();
    this.cfg = loadCfg() || { radius: 150, threshold: 60, expectedIntervalMs: 30000 };
    this.zone = this.cfg.zone || null;
    this.gfState = null;   // evaluateGeofence prior state
    this.watcherId = null;
    this.notifyId = 1000;  // LocalNotifications ids must be distinct ints
    this.el = null;
  }

  // Append a row, persist, and refresh the panel.
  _log(row) {
    const r = { at: Date.now(), ...row };
    this.rows.push(r);
    saveLog(this.rows);
    this._render();
    return r;
  }

  async start() {
    if (this.watcherId != null) return;
    await this._pluginsReady;
    try {
      // requestPermissions:true makes the plugin walk the user through
      // "Allow all the time" — the exact grant Phase 45's wizard will own.
      this.watcherId = await this.BG.addWatcher(
        {
          backgroundMessage: "JLTG Doze spike — recording location so it can prove background alerts fire.",
          backgroundTitle: "JLTG background spike",
          requestPermissions: true,
          stale: false,
          distanceFilter: 0, // report every fix so gap analysis reflects cadence, not motion
        },
        (location, error) => {
          if (error) {
            this._log({ type: "error", msg: String(error?.message || error?.code || error) });
            return;
          }
          this._onFix(location);
        },
      );
      // Make sure we can actually post a notification from a background tick.
      try { await this.LN.requestPermissions(); } catch { /* denied — notify() will no-op */ }
      this._log({ type: "start", watcherId: String(this.watcherId) });
    } catch (e) {
      this._log({ type: "error", msg: "addWatcher failed: " + String(e?.message || e) });
    }
  }

  async stop() {
    if (this.watcherId == null) return;
    const id = this.watcherId;
    this.watcherId = null;
    try { await this.BG.removeWatcher({ id }); } catch { /* already gone */ }
    this._log({ type: "stop" });
  }

  _onFix(location) {
    const fix = normalizeLocation(location);
    if (!fix) return;
    this._log({ type: "fix", lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, ts: fix.at });
    if (!this.zone) return;
    const { state, notify } = evaluateGeofence({
      position: { lat: fix.lat, lng: fix.lng },
      zone: this.zone,
      thresholdMetres: this.cfg.threshold,
      prior: this.gfState,
    });
    this.gfState = state;
    if (notify) this._notify(notify);
  }

  _notify({ title, body }) {
    const when = new Date();
    const stamp = when.toTimeString().slice(0, 8);
    // The timestamp in the body is the proof: a lock-screen glance shows exactly
    // when it fired, so we can line it up against the forced-Doze window.
    const full = `${body} · fired ${stamp}`;
    this._log({ type: "notify", title, body: full });
    const id = ++this.notifyId;
    try {
      this.LN.schedule({
        notifications: [{
          id,
          title: `[spike] ${title}`,
          body: full,
          schedule: { at: new Date(Date.now() + 50) },
        }],
      });
    } catch (e) {
      this._log({ type: "error", msg: "notify failed: " + String(e?.message || e) });
    }
  }

  // Drop the geofence where we are right now (last fix, else a one-shot fix).
  async setZoneHere() {
    await this._pluginsReady;
    let base = [...this.rows].reverse().find((r) => r.type === "fix");
    let fix = base ? { lat: base.lat, lng: base.lng, at: base.ts } : null;
    if (!fix) {
      try {
        const loc = await this.BG.getCurrentPosition?.();
        fix = normalizeLocation(loc);
      } catch { /* fall through */ }
    }
    const zone = spikeZoneFromFix(fix, { radius: this.cfg.radius });
    if (!zone) { this._log({ type: "error", msg: "no fix yet — start the watcher first" }); return; }
    this.zone = zone;
    this.gfState = null;
    this.cfg.zone = zone;
    saveCfg(this.cfg);
    this._log({ type: "geofence", lat: zone.point.lat, lng: zone.point.lng, radius: zone.radius, threshold: this.cfg.threshold });
  }

  clearLog() {
    this.rows = [];
    saveLog(this.rows);
    this._render();
  }

  async copyLog() {
    const text = JSON.stringify({ cfg: this.cfg, rows: this.rows }, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      this._flash("Copied log JSON to clipboard");
    } catch {
      // Clipboard blocked — dump to console so `adb logcat` / remote debug can grab it.
      console.log("[bgspike] log dump\n" + text);
      this._flash("Clipboard blocked — dumped to console");
    }
  }

  // --- UI (a self-contained diagnostic overlay; no shipped CSS needed) -----

  mount() {
    if (this.el) return;
    const el = document.createElement("div");
    el.id = "bgspike";
    el.setAttribute("style", [
      "position:fixed", "inset:0", "z-index:99999", "background:#0b1f27", "color:#dceef4",
      "font:13px/1.45 system-ui,sans-serif", "display:flex", "flex-direction:column", "padding:12px", "gap:8px",
    ].join(";"));
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px">
        <strong style="font-size:15px">🔬 Phase 40 · Doze spike</strong>
        <button data-a="close" style="margin-left:auto;background:none;border:0;color:#9fc3d0;font-size:20px">✕</button>
      </div>
      <div id="bgspike-verdict" style="border-radius:8px;padding:8px 10px;background:#12303b"></div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        <button data-a="start" style="${btn("#1f8a5b")}">▶ Start watcher</button>
        <button data-a="stop" style="${btn("#8a1f3a")}">■ Stop</button>
        <button data-a="zone" style="${btn("#1f5f8a")}">📍 Set geofence here</button>
        <button data-a="copy" style="${btn("#3a3f52")}">⧉ Copy log</button>
        <button data-a="clear" style="${btn("#3a3f52")}">🗑 Clear</button>
      </div>
      <div id="bgspike-summary" style="color:#9fc3d0"></div>
      <div id="bgspike-log" style="flex:1;overflow:auto;background:#08171d;border-radius:8px;padding:8px;font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap"></div>`;
    document.body.appendChild(el);
    this.el = el;
    el.addEventListener("click", (e) => {
      const a = e.target.closest("button[data-a]")?.dataset.a;
      if (a === "close") this.unmount();
      else if (a === "start") this.start();
      else if (a === "stop") this.stop();
      else if (a === "zone") this.setZoneHere();
      else if (a === "copy") this.copyLog();
      else if (a === "clear") this.clearLog();
    });
    this._render();
  }

  unmount() {
    this.el?.remove();
    this.el = null;
    try { location.hash = ""; } catch { /* ignore */ }
  }

  _flash(msg) {
    const v = this.el?.querySelector("#bgspike-verdict");
    if (v) { const old = v.textContent; v.textContent = msg; setTimeout(() => this._render(), 1500); }
  }

  _render() {
    if (!this.el) return;
    const summary = summarizeSpikeLog(this.rows);
    const verdict = spikeVerdict(summary, { expectedIntervalMs: this.cfg.expectedIntervalMs });
    const v = this.el.querySelector("#bgspike-verdict");
    if (v) {
      v.textContent = (verdict.pass ? "✅ PASS · " : "⏳ ") + verdict.reason;
      v.style.background = verdict.pass ? "#12402a" : (summary.fixCount ? "#42260f" : "#12303b");
    }
    const s = this.el.querySelector("#bgspike-summary");
    if (s) {
      const span = summary.firstAt && summary.lastAt ? Math.round((summary.lastAt - summary.firstAt) / 1000) : 0;
      s.textContent = `watcher:${this.watcherId != null ? "ON" : "off"}  fixes:${summary.fixCount}  notifs:${summary.notifyCount}  errors:${summary.errorCount}  ` +
        `median gap:${fmtGap(summary.medianGapMs)}  max gap:${fmtGap(summary.maxGapMs)}  span:${span}s  ` +
        (this.zone ? `zone:${this.cfg.radius}m/±${this.cfg.threshold}m` : "zone:—");
    }
    const log = this.el.querySelector("#bgspike-log");
    if (log) log.textContent = this.rows.slice(-60).reverse().map(fmtRow).join("\n");
  }
}

function btn(bg) {
  return `background:${bg};border:0;border-radius:8px;color:#fff;padding:8px 10px;font-size:13px`;
}
function fmtGap(ms) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}
function fmtRow(r) {
  const t = new Date(r.at).toTimeString().slice(0, 8);
  if (r.type === "fix") return `${t}  fix   ${r.lat.toFixed(5)},${r.lng.toFixed(5)}  ±${r.accuracy != null ? Math.round(r.accuracy) : "?"}m`;
  if (r.type === "notify") return `${t}  🔔    ${r.title} — ${r.body}`;
  if (r.type === "geofence") return `${t}  zone  ${r.lat.toFixed(5)},${r.lng.toFixed(5)}  r=${r.radius}m ±${r.threshold}m`;
  if (r.type === "error") return `${t}  ⚠️    ${r.msg}`;
  return `${t}  ${r.type}`;
}

// Entry point wired from app.js. No-op unless the hash asks for the spike AND
// we're in the native shell — so it can never intrude on a normal web boot.
export function initBgSpike() {
  if (typeof window === "undefined") return;
  let spike = null;
  const sync = () => {
    const want = location.hash.replace(/^#/, "").toLowerCase() === "bgspike";
    if (want && isNativeCapacitor()) {
      if (!spike) spike = new BgSpike();
      spike.mount();
    } else if (spike) {
      spike.unmount();
    }
  };
  window.addEventListener("hashchange", sync);
  sync();
}
