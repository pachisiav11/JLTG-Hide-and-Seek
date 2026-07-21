# Phase 40 — the real-phone Doze spike

Phase 40 of [`BUILD_PLAN_2026-07-21.md`](../BUILD_PLAN_2026-07-21.md). This is a
**spike**, not a shipped feature — a controlled experiment on a physical phone
that answers the one question the rest of the native track is gated on:

> When an Android phone is **locked, stationary and screen-off** long enough to
> enter **Doze**, does a **free** background-location plugin keep delivering
> fixes — and can we fire a notification off one — or does the OS suspend it?

The answer picks the architecture for Phases 41–44:

| Result | Meaning | Consequence |
| --- | --- | --- |
| **PASS** | The community background-geolocation **foreground service** keeps delivering fixes in Doze. | The hider geofence can ride it: compute the band in JS (`evaluateGeofence`) and fire a local notification. Simpler, no server. |
| **FAIL** | The foreground service is throttled/suspended in Doze. | The hider **must** use native **OS geofencing** (`GeofencingClient` fires a `BroadcastReceiver` even in Doze), and the seeker-close path **must** use **high-priority FCM**. More work, but the only Doze-proof option. |

Either way the result is **conclusive and recorded**, not a hunch.

---

## What's wired (committed, in this repo)

- [`src/bg-spike.js`](../src/bg-spike.js) — the spike harness. It is **inert**
  unless the URL is `…/#bgspike` **and** it's running inside the Capacitor native
  shell (`window.Capacitor.isNativePlatform()`), so it never touches a normal
  web/PWA boot. It:
  1. opens `@capacitor-community/background-geolocation`'s watcher — a
     **foreground service** (persistent notification), the free thing under test;
  2. stamps **every fix with wall-clock time** and persists the log to
     `localStorage` (key `jltg.bgspike.log`) so a Doze-kill of the WebView can't
     erase the evidence — on relaunch the history is still there;
  3. drops a geofence at your position and, reusing the **same**
     `evaluateGeofence` band machine the real hider uses, fires a
     `@capacitor/local-notifications` alert (stamped with the time) on each
     band crossing;
  4. reduces the log to a **verdict** from the inter-fix **gaps** — a gap many
     times the requested cadence means the OS parked the plugin.
- The verdict logic is unit-tested headlessly in
  [`test/bg-spike.test.mjs`](../test/bg-spike.test.mjs) (steady run passes; one
  Doze-sized gap fails; no/too-few fixes resolve to an honest "can't tell").
- `package.json` declares the two native-only plugins as devDependencies.

Because the shell loads the **live Pages site**, the spike JS reaches the phone
with the normal web deploy — but the two **native plugins** are new, so this
phase **does** require an APK rebuild (below).

---

## Build the spike APK

Do the [`ANDROID_BUILD.md`](./ANDROID_BUILD.md) first-build steps once, then add
the plugins. From the repo root:

```sh
npm install                       # pulls the two new plugins into node_modules
npx cap add android               # if android/ doesn't exist yet
npx cap sync android              # copies the plugins into the native project
```

### Two required native edits (the generated `android/` is git-ignored)

`npx cap sync` wires the plugin code in, but Android still needs the permissions
and the foreground-service declaration. Edit
`android/app/src/main/AndroidManifest.xml`:

1. Inside `<manifest>`, above `<application>`, add:
   ```xml
   <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
   <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
   <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
   <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
   <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
   <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
   ```
2. The `@capacitor-community/background-geolocation` plugin ships its own
   `<service>` entry via manifest merge, so you normally don't add one by hand —
   after `npx cap sync`, confirm the merged manifest contains
   `com.equimaps.capacitorplugin.BackgroundGeolocationService` (build once and
   check `android/app/build/intermediates/merged_manifests/…`). If it's absent on
   your plugin version, add it per the plugin README.

Then build + install onto a connected device:

```sh
npx cap run android          # or: cd android && ./gradlew assembleDebug
```

> These native edits live only in the generated project. If you ever
> `rm -rf android && npx cap add android`, redo them. That's expected for a
> spike — Phase 41 folds them into a committed native config.

---

## Grant the permissions (or the spike measures nothing)

On the phone, **Settings ▸ Apps ▸ JLTG H&S ▸ Permissions ▸ Location ▸ "Allow all
the time"** — not just "While using". Also allow **Notifications**. Then the big
one people miss:

**Settings ▸ Apps ▸ JLTG H&S ▸ Battery ▸ "Unrestricted"** (a.k.a. remove from
battery optimization). *Leave this ON for the baseline run below, then you'll
retest with it OFF — the difference is itself a finding for the Phase 45 wizard.*

---

## Run the spike

1. Open the app, then navigate the WebView to the spike overlay: easiest is to
   add `#bgspike` to the URL. In the debug build you can do this from
   `chrome://inspect` (Remote devices ▸ **inspect** ▸ run
   `location.hash = "bgspike"` in the console), or temporarily point
   `capacitor.config.ts` `server.url` at `…/#bgspike` and re-sync. The overlay
   is a dark full-screen panel titled **🔬 Phase 40 · Doze spike**.
2. Tap **▶ Start watcher**. Approve the location + notification prompts. A
   persistent "JLTG background spike" notification appears — that's the
   foreground service. Fixes start streaming into the log.
3. Tap **📍 Set geofence here** to drop a 150 m zone (±60 m alert band) at your
   current spot.

You now have two things to prove: **fixes keep coming in Doze**, and **a
crossing notification fires in Doze**.

### The conclusive part — force Doze with adb (don't wait an hour)

Doze normally takes ~30–60 min of stillness. Force it instead, so the result is
fast and repeatable. With the phone connected and screen **off**:

```sh
adb shell dumpsys deviceidle force-idle
```

Verify it took — this should print `mState=IDLE`:

```sh
adb shell dumpsys deviceidle get deep
```

Now, **while still in forced Doze**, exercise both signals:

- **Fix cadence:** leave it idle for ~10–15 minutes. (Optionally feed movement
  with a mock-location app + `adb shell appops set <pkg> android:mock_location
  allow`, or just carry the phone.)
- **Geofence crossing:** move the phone across the 150 m zone edge (walk it, or
  mock a coordinate ~200 m from where you set the zone). Watch for the
  **`[spike] …`** notification on the lock screen — its body is stamped with the
  time it fired.

Release Doze when done:

```sh
adb shell dumpsys deviceidle unforce
adb shell dumpsys battery reset
```

Re-open the overlay. The **verdict banner** at the top reads the persisted log
and says **✅ PASS** or **⏳/❌** with the reason. Tap **⧉ Copy log** to grab the
raw JSON (also dumped to `adb logcat` if the clipboard is blocked).

---

## Reading the result — what makes it conclusive

The overlay's verdict is computed by `spikeVerdict()`, the same function the
unit tests pin. The logic:

- **PASS** — ≥ 3 fixes and the **largest inter-fix gap ≤ 4× the requested 30 s
  cadence** (≤ 120 s). Fixes kept arriving through the forced-Doze window → the
  free foreground-service path is Doze-proof enough for the hider geofence.
- **FAIL** — the largest gap **exceeds** 120 s. The plugin was suspended in Doze.
  A single 10-minute hole fails the run even if every other fix was perfect —
  that hole is exactly the 45-minute silence a real hider would get.
- **Can't tell yet** — 0–2 fixes. Grant permissions / let it run longer.

Cross-check the two independent signals — they must agree:

1. **Gap analysis** (the number): `max gap` in the summary line stayed ≤ 120 s.
2. **The notification** (the lived proof): a `[spike]` alert actually landed on
   the lock screen *during* the forced-Doze window, with a timestamp inside that
   window.

If both hold → **PASS**. If fixes stalled or no notification arrived while
`mState=IDLE` → **FAIL**.

### Run it twice — the battery-exemption delta

Run the whole thing **once with battery = Unrestricted** and **once with the
battery-optimization exemption OFF**. Record both verdicts. The common real-world
outcome is *pass with the exemption, fail without* — which is precisely why the
Phase 45 setup wizard must detect the exemption and deep-link the user to grant
it. Note which OEM/Android version you tested (Samsung/Xiaomi/Oppo are the
aggressive ones).

---

## Record the outcome

Put the result where Phase 41 will read it:

- The **PASS/FAIL verdict**, the **max gap**, and **whether the notification
  fired in Doze**, for **both** battery settings.
- The **device model + Android version + OEM skin**.
- Paste the copied log JSON into the Phase 40 commit message or a
  `docs/PHASE40_RESULTS.md`.

Then pick the Phase 41 path from the table at the top:
**PASS →** hider geofence on the foreground service; **FAIL →** native OS
geofencing + FCM.
