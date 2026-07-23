// Phase 45 (Stage 6): the Android permissions setup wizard.
//
// Every background alert built in Phases 41–44 silently fails without two grants
// Android/OEMs bury deep in Settings:
//   1. Location set to "Allow all the time" (not just "While using the app") —
//      without it the OS downgrades the foreground service to foreground-only and
//      the locked-pocket alerts never fire.
//   2. A battery-optimization EXEMPTION — without it aggressive OEM battery
//      managers (the Phase 40 spike met ColorOS's) can still park the service.
//   3. (Android 13+) the POST_NOTIFICATIONS runtime grant — without it the local
//      notification is posted but never shown.
//
// The cruel part is that everything LOOKS fine when these are missing: the app
// runs, the pill updates, no error appears — the alert just never arrives in the
// one session it mattered. So this wizard makes the invisible visible: detect
// each grant, explain WHY it's needed, deep-link to the exact settings screen,
// and clearly flag the background feature as INACTIVE until they're all granted.
//
// The grant → wizard-step mapping and the readiness logic are pure and unit-
// tested; querying the grants and opening the settings screens need the device.

import { isNativeCapacitor } from "./bg-spike.js";

// The three grants a background alert depends on. `id` doubles as the deep-link
// target and the DOM data-attribute.
export const PERMISSION_STEPS = [
  {
    id: "location",
    title: "Location: “Allow all the time”",
    why: "Background alerts read your position while the phone is locked. “While using the app” isn’t enough — Android stops sharing location the moment the screen goes off.",
    grantedWhen: (g) => g.location === "always",
    blockedWhen: (g) => g.location === "denied",
  },
  {
    id: "notifications",
    title: "Notifications: allowed",
    why: "The edge and seeker-close alerts are posted as notifications. Without this they fire silently into nothing.",
    grantedWhen: (g) => g.notifications === "granted",
    blockedWhen: (g) => g.notifications === "denied",
  },
  {
    id: "battery",
    title: "Battery: don’t optimise this app",
    why: "Aggressive battery managers can suspend the alert service in deep sleep. Exempting the app keeps it alive in your pocket.",
    grantedWhen: (g) => g.battery === "exempt",
    blockedWhen: (g) => false, // battery is never a hard "denied"; it's exempt or not
  },
];

// A fresh, all-unknown grant state (before we've queried, or off-device).
export function unknownGrants() {
  return { location: "unknown", notifications: "unknown", battery: "unknown" };
}

// Map a grant state to the wizard steps with a status each:
//   "granted"  — done, show a ✓
//   "action"   — not yet; offer the deep-link button
//   "unknown"  — couldn't read it (pre-query / plugin gap); offer the button anyway
export function wizardSteps(grant = unknownGrants()) {
  return PERMISSION_STEPS.map((step) => {
    let status;
    if (step.grantedWhen(grant)) status = "granted";
    else if (grant[step.id] === "unknown") status = "unknown";
    else status = "action";
    return { id: step.id, title: step.title, why: step.why, status, blocked: !!step.blockedWhen(grant) };
  });
}

// Are ALL background-alert grants in place? Drives the "feature active / inactive"
// banner. Strict: an unknown is NOT ready (we don't claim active when unsure).
export function permissionsReady(grant = unknownGrants()) {
  return PERMISSION_STEPS.every((s) => s.grantedWhen(grant));
}

// The steps still standing between the user and working background alerts.
export function blockingSteps(grant = unknownGrants()) {
  return wizardSteps(grant).filter((s) => s.status !== "granted");
}

// One-line status for the banner: how many of N grants are in place.
export function grantSummary(grant = unknownGrants()) {
  const steps = wizardSteps(grant);
  const done = steps.filter((s) => s.status === "granted").length;
  return { done, total: steps.length, ready: permissionsReady(grant) };
}

// --- HTML (pure string; games.js drops it into the Guide's Android section) ---

const STATUS_BADGE = { granted: "✅", action: "⚠️", unknown: "❔" };

export function wizardHTML(grant = unknownGrants()) {
  const steps = wizardSteps(grant);
  const { done, total, ready } = grantSummary(grant);
  const banner = ready
    ? `<p class="ok-note">✅ Background alerts are active — all ${total} permissions are granted.</p>`
    : `<p class="warn-note">⚠️ Background alerts are <strong>inactive</strong> until the steps below are done (${done}/${total} granted). The app still works foreground.</p>`;
  const rows = steps.map((s) => {
    const badge = STATUS_BADGE[s.status] || "❔";
    const btn = s.status === "granted"
      ? ""
      : `<button class="btn btn-small" data-perm="${s.id}">Open settings</button>`;
    return `<li class="perm-step perm-${s.status}">
      <div class="perm-head"><span class="perm-badge">${badge}</span><strong>${s.title}</strong>${btn}</div>
      <p class="muted">${s.why}</p>
    </li>`;
  }).join("");
  return `${banner}<ul class="perm-wizard">${rows}</ul>
    <p class="muted">After changing a setting, come back and reopen this Guide to re-check.</p>`;
}

// --- Native queries + deep-links (need the device) -------------------------

async function loadPlugins() {
  try {
    const { registerPlugin } = await import("../vendor/capacitor-core.js");
    return {
      BG: registerPlugin("BackgroundGeolocation"),
      LN: registerPlugin("LocalNotifications"),
      PN: registerPlugin("PushNotifications"),
    };
  } catch (e) {
    console.warn("native-permissions: could not load plugins", e);
    return null;
  }
}

// Read the current grants. Native-only; off-device returns all-unknown so the
// wizard shows an honest "can't check in the browser". Every read is defensive —
// a plugin that lacks a check method leaves that grant "unknown" rather than
// throwing, so one missing API can't blank the whole wizard. `plugins` injectable.
export async function queryGrants({ isNative = isNativeCapacitor, plugins = null } = {}) {
  if (!isNative()) return unknownGrants();
  const p = plugins || (await loadPlugins());
  const grant = unknownGrants();
  if (!p) return grant;

  // Location "all the time" — the community plugin exposes the coarse/precise
  // grant; "always"/"background" both mean the all-the-time grant we need.
  try {
    const loc = await p.BG?.checkPermissions?.();
    const v = loc?.location || loc?.background;
    if (v === "granted" || v === "always" || v === "background") grant.location = "always";
    else if (v === "denied") grant.location = "denied";
    else if (v) grant.location = "whileInUse";
  } catch { /* leave unknown */ }

  // Notifications (Android 13+ runtime grant).
  try {
    const ln = await p.LN?.checkPermissions?.();
    if (ln?.display === "granted") grant.notifications = "granted";
    else if (ln?.display === "denied") grant.notifications = "denied";
  } catch { /* leave unknown */ }

  // Battery-optimization exemption. No standard Capacitor API — a custom native
  // method is the documented manual half; if present we read it, else unknown.
  try {
    const bat = await p.BG?.checkBatteryOptimizations?.();
    if (bat && typeof bat.exempt === "boolean") grant.battery = bat.exempt ? "exempt" : "optimized";
  } catch { /* leave unknown */ }

  return grant;
}

// Deep-link to the settings screen for a step. Native-only; opens the app's
// settings (where "Allow all the time" + notifications live) via the plugin's
// openSettings, and — for battery — a custom intent if the native layer provides
// one (documented manual half). Returns true if an opener was invoked.
export async function openSettingsFor(stepId, { isNative = isNativeCapacitor, plugins = null } = {}) {
  if (!isNative()) return false;
  const p = plugins || (await loadPlugins());
  if (!p) return false;
  try {
    if (stepId === "battery" && typeof p.BG?.openBatterySettings === "function") {
      await p.BG.openBatterySettings();
      return true;
    }
    if (typeof p.BG?.openSettings === "function") { await p.BG.openSettings(); return true; }
    if (typeof p.LN?.openSettings === "function") { await p.LN.openSettings(); return true; }
  } catch (e) {
    console.warn("native-permissions: openSettings failed", e);
  }
  return false;
}
