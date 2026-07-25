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
  hardBlockers,
  unverifiable,
  blockingToastText,
  readinessNoteHTML,
  mountReadinessNote,
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
  // The plugin's permission alias covers only ACCESS_FINE/COARSE — it has no
  // concept of ACCESS_BACKGROUND_LOCATION, so a plain "granted" here can only
  // mean "while using the app". Reporting that as "always" was a false ✅ that
  // told a hider background alerts were armed when the OS grant that matters
  // for a locked phone might not be in place at all. Only an explicit "denied"
  // is a signal we can trust, so "granted" now maps to "unknown".
  assert.deepEqual(g, { location: "unknown", notifications: "granted", battery: "exempt" });
});

test('queryGrants marks location "denied" when the plugin reports it (the one location signal that IS reliable)', async () => {
  const plugins = {
    BG: { checkPermissions: async () => ({ location: "denied" }) },
    LN: { checkPermissions: async () => ({ display: "granted" }) },
    PN: {},
  };
  const g = await queryGrants({ isNative: () => true, plugins });
  assert.equal(g.location, "denied");
});

test("queryGrants marks notifications denied when areEnabled() says so, even if checkPermissions looked granted", async () => {
  // checkPermissions() alone misses e.g. the user disabling notifications for the
  // app after granting the runtime prompt, or the prompt being auto-denied by a
  // permission-request race — areEnabled() is the same check schedule() itself
  // relies on, so it catches what checkPermissions can miss.
  const plugins = {
    BG: { checkPermissions: async () => ({ location: "denied" }) },
    LN: {
      checkPermissions: async () => ({ display: "granted" }),
      areEnabled: async () => ({ value: false }),
    },
    PN: {},
  };
  const g = await queryGrants({ isNative: () => true, plugins });
  assert.equal(g.notifications, "denied", "areEnabled() overrides a stale/incomplete checkPermissions granted");
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

test("hardBlockers returns only steps with status 'action' (denied or unverified-non-unknown)", () => {
  // All unknown → no hard blockers
  const g1 = unknownGrants();
  assert.equal(hardBlockers(g1).length, 0, "unknown grants are not hard blockers");

  // One hard blocker (location denied)
  const g2 = { location: "denied", notifications: "granted", battery: "exempt" };
  const hard2 = hardBlockers(g2);
  assert.equal(hard2.length, 1);
  assert.equal(hard2[0].id, "location");

  // Mixed: one action, one unknown, one granted
  const g3 = { location: "denied", notifications: "unknown", battery: "exempt" };
  const hard3 = hardBlockers(g3);
  assert.equal(hard3.length, 1, "only the action step is in hardBlockers");
  assert.equal(hard3[0].id, "location");
});

test("unverifiable returns only steps with status 'unknown'", () => {
  // All unknown → all unverifiable
  const g1 = unknownGrants();
  const unv1 = unverifiable(g1);
  assert.equal(unv1.length, 3);
  assert.deepEqual(unv1.map((s) => s.id), ["location", "notifications", "battery"]);

  // All granted → no unverifiable
  const g2 = ALL_GOOD;
  assert.equal(unverifiable(g2).length, 0);

  // Mixed: one unknown, rest granted
  const g3 = { location: "always", notifications: "unknown", battery: "exempt" };
  const unv3 = unverifiable(g3);
  assert.equal(unv3.length, 1);
  assert.equal(unv3[0].id, "notifications");
});

test("blockingToastText returns the first hard blocker's title + fix, or null if none", () => {
  // No hard blockers
  const g1 = unknownGrants();
  assert.equal(blockingToastText(g1), null, "all unknown → no blockers → null");

  const g2 = ALL_GOOD;
  assert.equal(blockingToastText(g2), null, "all granted → no blockers → null");

  // One hard blocker
  const g3 = { location: "denied", notifications: "granted", battery: "exempt" };
  const txt3 = blockingToastText(g3);
  assert.ok(txt3, "hard blocker present → returns text");
  assert.match(txt3, /location/i, "contains blocker title");
  assert.match(txt3, /Allow all the time/, "contains the fix text");

  // Multiple hard blockers → returns first one
  const g4 = { location: "denied", notifications: "denied", battery: "optimized" };
  const txt4 = blockingToastText(g4);
  assert.match(txt4, /location/i, "first blocker (location) is used");
});

test("readinessNoteHTML: hard blocker present → warn-note with data-perm-guide button", () => {
  const g = { location: "denied", notifications: "granted", battery: "exempt" };
  const html = readinessNoteHTML(g);
  assert.match(html, /warn-note/, "hard blocker triggers warning class");
  assert.match(html, /won't arrive yet/, "warning message");
  assert.match(html, /data-perm-guide/, "button to open guide");
  assert.match(html, /Location/, "names the blocker");
});

test("readinessNoteHTML: unverifiable-only grant → muted note with data-perm-guide button", () => {
  const g = unknownGrants();
  const html = readinessNoteHTML(g);
  assert.match(html, /muted/, "unverifiable-only triggers muted class");
  assert.match(html, /can't auto-check/, "message about unverifiable");
  assert.match(html, /data-perm-guide/, "button to verify permissions");
  assert.ok(!/warn-note/.test(html), "not a hard warning");
});

test("readinessNoteHTML: all grants present → ok-note with no button", () => {
  const html = readinessNoteHTML(ALL_GOOD);
  assert.match(html, /ok-note/, "all clear triggers ok class");
  assert.match(html, /set up/, "mentions alerts are set up");
  assert.ok(!/data-perm-guide/.test(html), "no button when everything is set");
});

test("mountReadinessNote: off-device is a no-op", async () => {
  const container = { innerHTML: "original" };
  await mountReadinessNote(container, { isNative: () => false });
  assert.equal(container.innerHTML, "original", "container untouched off-device");
});

test("mountReadinessNote: no-op when container is falsy", async () => {
  // Testing with null
  await mountReadinessNote(null, { isNative: () => true });
  // No assertion needed, just shouldn't throw.

  // Testing with undefined
  await mountReadinessNote(undefined, { isNative: () => true });
  // No assertion needed, just shouldn't throw.
});

test("mountReadinessNote: on-device sets innerHTML and wires the guide button", async () => {
  const button = { onclick: null };
  const container = {
    innerHTML: "",
    querySelector: (sel) => (sel === "button[data-perm-guide]" ? button : null),
  };
  let guideOpened = false;
  const queryFn = async () => ({ location: "denied", notifications: "granted", battery: "exempt" });
  await mountReadinessNote(container, {
    isNative: () => true,
    queryFn,
    onOpenGuide: () => { guideOpened = true; },
  });
  assert.ok(container.innerHTML.length > 0, "innerHTML was set");
  assert.match(container.innerHTML, /warn-note/, "readiness HTML was inserted");
  assert.ok(button.onclick, "button onclick was wired");
  button.onclick();
  assert.equal(guideOpened, true, "clicking the button calls onOpenGuide");
});

test("mountReadinessNote: queryFn rejection doesn't throw", async () => {
  const container = { innerHTML: "" };
  const queryFn = async () => {
    throw new Error("Query failed");
  };
  // Should not throw
  await mountReadinessNote(container, {
    isNative: () => true,
    queryFn,
  });
  // Container should be untouched after a query failure
  assert.equal(container.innerHTML, "", "container unchanged when query fails");
});
