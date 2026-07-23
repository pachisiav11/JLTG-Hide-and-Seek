# Phase 45 — permissions setup wizard

**Status:** code + headless tests committed (`src/native-permissions.js`, Guide
wiring in `src/games.js`, 11 tests). The **device walkthrough is manual** (tapping
through to each OEM settings screen).

Completes Phase 38's Guide and reqs #8/#9.

## What this phase does

Every background alert built in Phases 41–44 silently fails without grants that
Android/OEMs bury deep in Settings — and the cruel part is nothing *looks* wrong:
the app runs, the pill updates, the alert just never arrives. This wizard makes
the invisible visible. On the Android shell, the Guide's "📲 Background alerts"
section becomes a live wizard that, for each required grant:

- **Detects** the current state (`queryGrants` via the plugins),
- **Explains** why it's needed,
- **Deep-links** to the exact settings screen (`openSettingsFor`), and
- **Flags the feature INACTIVE** until all three are granted (a green "active"
  banner once they are).

The three grants:

1. **Location "Allow all the time"** — "while using" is not enough; Android stops
   sharing location when the screen goes off.
2. **Notifications allowed** (Android 13+ `POST_NOTIFICATIONS`).
3. **Battery-optimization exemption** — so aggressive OEM battery managers (the
   Phase 40 spike met ColorOS's) can't suspend the service in deep sleep.

Off-device the honest static caveat stays (there are no grants to detect in a
browser). The grant→step mapping and readiness logic are strict: a grant that is
merely **unknown** is never counted as ready, so the wizard never tells a hider
"you're all set" when it couldn't actually confirm the one grant that matters.

## Manual half — device walkthrough + native wiring

1. **Native queries.** `queryGrants` reads:
   - location via the background-geolocation plugin's `checkPermissions()`,
   - notifications via `LocalNotifications.checkPermissions()`,
   - battery via a **custom** `checkBatteryOptimizations()` — no standard
     Capacitor API exists, so add a tiny native method (returns `{exempt:boolean}`)
     in the Android layer. Until it exists, the battery step shows "unknown" and
     still offers the settings deep-link (honest, not broken).
2. **Deep-links.** `openSettingsFor` calls the plugin's `openSettings()` for
   location/notifications (opens the app's settings page). For battery, add a
   native `openBatterySettings()` that fires
   `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (or the OEM's battery screen).
3. **Walkthrough QA:** open the Guide on the APK with no grants → confirm the
   inactive banner + three ⚠️ steps. Tap each "Open settings", grant it, return,
   reopen the Guide → confirm the badge flips to ✅ and, once all three are done,
   the green "active" banner shows.

## Files

- `src/native-permissions.js` — `wizardSteps` / `permissionsReady` /
  `blockingSteps` / `grantSummary` / `wizardHTML` (pure) + `queryGrants` /
  `openSettingsFor` (native).
- `src/games.js` — `openGuide` mounts the live wizard on the native shell and
  wires the deep-link buttons.
- `src/guide.js` — the Android section is now the off-device fallback copy.
- `styles/main.css` — `.ok-note`, `.perm-wizard`, `.perm-step`, `.btn-small`.
- `test/native-permissions.test.mjs` — 11 tests on the grant→step mapping,
  readiness, blocking list, HTML, and defensive `queryGrants`.
- SW cache → **v106** (new shell asset `src/native-permissions.js`).
