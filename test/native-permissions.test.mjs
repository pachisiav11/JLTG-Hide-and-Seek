// Phase 45 test: the Android permissions setup wizard's grant → step mapping.
//
// The device walkthrough (tap through to each OEM settings screen) is manual.
// What's pinnable — and what the whole wizard's honesty rests on — is the
// mapping from the detected grant state to what the user is shown:
//   - a step is "granted" only when its exact requirement is met ("Allow all the
//     time", not merely "while using"),
//   - background alerts are declared ACTIVE only when ALL grants are in place, and
//     never when any grant is merely unknown (we don't claim active when unsure),
//   - the "still blocking" list and the banner counts are correct,
//   - and the rendered HTML reflects all of that (badges, the inactive banner, a
//     deep-link button on exactly the not-yet-granted steps).
// If this drifts, the wizard could tell a hider "you're all set" while the one
// grant that makes locked-pocket alerts work is missing — the exact silent
// failure the wizard exists to prevent.
import test from "node:test";
import assert from "node:assert/strict";

const {
  wizardSteps,
  permissionsReady,
  blockingSteps,
  grantSummary,
  wizardHTML,
  unknownGrants,
  queryGrants,
} = await import("../src/native-permissions.js");

const ALL_GOOD = { location: "always", notifications: "granted", battery: "exempt" };

test("all-granted → every step granted, feature ACTIVE", () => {
  const steps = wizardSteps(ALL_GOOD);
  assert.deepEqual(steps.map((s) => s.status), ["granted", "granted", "granted"]);
  assert.equal(permissionsReady(ALL_GOOD), true);
  assert.equal(blockingSteps(ALL_GOOD).length, 0);
  assert.deepEqual(grantSummary(ALL_GOOD), { done: 3, total: 3, ready: true });
});

test('"while using" location is NOT enough — it needs "all the time"', () => {
  const g = { ...ALL_GOOD, location: "whileInUse" };
  const loc = wizardSteps(g).find((s) => s.id === "location");
  assert.equal(loc.status, "action", "while-using must still prompt the user to upgrade to all-the-time");
  assert.equal(permissionsReady(g), false, "background alerts must NOT be declared active");
});

test("a denied grant is flagged blocked and never ready", () => {
  const g = { location: "denied", notifications: "granted", battery: "exempt" };
  const loc = wizardSteps(g).find((s) => s.id === "location");
  assert.equal(loc.status, "action");
  assert.equal(loc.blocked, true);
  assert.equal(permissionsReady(g), false);
});

test("unknown grants are NOT counted as ready (no false all-clear)", () => {
  const g = unknownGrants();
  assert.equal(permissionsReady(g), false);
  assert.deepEqual(wizardSteps(g).map((s) => s.status), ["unknown", "unknown", "unknown"]);
  assert.equal(grantSummary(g).done, 0);
});

test("battery is exempt-or-not (never a hard denial), and gates readiness", () => {
  const g = { location: "always", notifications: "granted", battery: "optimized" };
  const bat = wizardSteps(g).find((s) => s.id === "battery");
  assert.equal(bat.status, "action");
  assert.equal(bat.blocked, false, "battery optimization is not a permission 'denial'");
  assert.equal(permissionsReady(g), false, "an optimised app still can't run background alerts");
});

test("blockingSteps lists exactly the not-yet-granted grants", () => {
  const g = { location: "always", notifications: "denied", battery: "optimized" };
  assert.deepEqual(blockingSteps(g).map((s) => s.id).sort(), ["battery", "notifications"]);
});

test("wizardHTML shows the INACTIVE banner + a deep-link on each pending step", () => {
  const html = wizardHTML({ location: "always", notifications: "denied", battery: "optimized" });
  assert.match(html, /inactive/i, "banner warns the feature is off");
  assert.match(html, /1\/3 granted/, "counts the one granted step");
  // Deep-link buttons only on the two pending steps, not on the granted one.
  assert.match(html, /data-perm="notifications"/);
  assert.match(html, /data-perm="battery"/);
  assert.ok(!/data-perm="location"/.test(html), "no settings button on an already-granted step");
});

test("wizardHTML shows the ACTIVE banner when everything is granted", () => {
  const html = wizardHTML(ALL_GOOD);
  assert.match(html, /active/i);
  assert.ok(!/data-perm=/.test(html), "no settings buttons when all granted");
});

test("queryGrants is all-unknown off-device (honest 'can't check in the browser')", async () => {
  const g = await queryGrants({ isNative: () => false });
  assert.deepEqual(g, unknownGrants());
});

test("queryGrants reads each grant from the plugins defensively", async () => {
  const plugins = {
    BG: {
      checkPermissions: async () => ({ location: "granted" }),
      checkBatteryOptimizations: async () => ({ exempt: true }),
    },
    LN: { checkPermissions: async () => ({ display: "granted" }) },
    PN: {},
  };
  const g = await queryGrants({ isNative: () => true, plugins });
  assert.deepEqual(g, { location: "always", notifications: "granted", battery: "exempt" });
});

test("queryGrants leaves a grant 'unknown' when its plugin method is missing/throws", async () => {
  const plugins = {
    BG: { checkPermissions: async () => { throw new Error("no api"); } }, // throws → unknown
    LN: { checkPermissions: async () => ({ display: "denied" }) },
    PN: {},
  };
  const g = await queryGrants({ isNative: () => true, plugins });
  assert.equal(g.location, "unknown", "a throwing check must not blank the whole wizard");
  assert.equal(g.notifications, "denied");
  assert.equal(g.battery, "unknown", "missing battery API → unknown, not a false 'exempt'");
});
