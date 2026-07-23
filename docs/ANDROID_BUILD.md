# Android build & sideload (Capacitor shell)

Phase 39 (Stage 5) of [`BUILD_PLAN_2026-07-21.md`](../BUILD_PLAN_2026-07-21.md).

The Android app is a thin **Capacitor** WebView that loads the **live GitHub
Pages site** — it is not a bundled copy of the web app. Every web phase
(27–38) auto-deploys to Pages and reaches the app with **no APK rebuild**. You
only rebuild the APK for native changes (the background plugins, Phases 40–45).

> **Why load remote, not bundle?** The game already needs a network for map
> tiles + the live-share relay, so requiring one at launch costs nothing, and it
> means web fixes ship without re-signing and re-sideloading an APK to everyone.
> The one bundled asset is [`capacitor-www/offline.html`](../capacitor-www/offline.html),
> the "no connection" fallback.

---

## What's in the repo (committed)

| File | Purpose |
| --- | --- |
| [`capacitor.config.ts`](../capacitor.config.ts) | App id/name, `server.url` → the Pages site, `errorPath` → the offline page, `allowNavigation` allowlist. |
| [`capacitor-www/offline.html`](../capacitor-www/offline.html) | Self-contained "no connection" screen with reload steps + a Reload button. |
| [`capacitor-www/index.html`](../capacitor-www/index.html) | Momentary loading placeholder before the remote page takes over. |
| `package.json` | Declares the Capacitor devDependencies + `cap:sync` / `cap:open` scripts. |

**Generated, NOT committed** (see `.gitignore`): the `android/` Gradle project
(`npx cap add android` recreates it from the config above) and any keystore.

---

## Prerequisites (Windows)

1. **JDK 21** (Temurin/Adoptium) — `java -version` should report 21.
2. **Android Studio** (latest) with the **Android SDK** + **Platform Tools**
   (adb) installed via its SDK Manager.
3. **Node 18+** (already required by this repo).
4. A physical **Android phone** with Developer Options → **USB debugging** on
   (an emulator can't exercise real GPS/geofencing — use a device).

Set `JAVA_HOME` to the JDK 21 path and add `platform-tools` (adb) to `PATH`.

---

## First build

```sh
# 1. Install the Capacitor toolchain (native-build-only devDependencies).
npm install

# 2. Initialise Capacitor if capacitor.config.ts is ever missing (it is
#    committed, so normally SKIP this — do not overwrite the committed config).
#    npx cap init "JLTG H&S" com.pachisiav11.jltg --web-dir capacitor-www

# 3. Add the Android platform (generates the ignored android/ project).
npx cap add android

# 4. Copy web assets + config into the native project.
npx cap sync android      # or: npm run cap:sync

# 5. Run on a connected device (installs + launches the debug build).
npx cap run android
```

`npx cap run android` builds a **debug** APK, installs it over USB, and launches
it. The WebView should load `https://pachisiav11.github.io/JLTG-Hide-and-Seek/`
and behave exactly like the PWA.

### App icon + name

The launcher name is `JLTG H&S` (from `appName`). To set the launcher icon,
open the project in Android Studio (`npm run cap:open`) → right-click
`app/res` → **New ▸ Image Asset**, and use `icons/icon-512.png` as the source.

---

## Sideload build for the group (no Play Store)

A **debug** APK is enough to sideload to the playgroup — no Play Store, no
release signing required.

```sh
# Build a debug APK from the generated project.
cd android
./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Share `app-debug.apk` (e.g. via the group chat / a link). Each player enables
**Install unknown apps** for their browser/file manager, taps the APK, and
installs. Debug APKs are signed with Android's shared debug key — fine for
sideloading, but each rebuild must be installed over the previous one (same
signature) or uninstalled first if the signature ever changes.

> A proper self-signed **release** key is only needed if you want a stable
> long-term signature. If so: `keytool -genkey -v -keystore jltg-release.jks
> -keyalg RSA -keysize 2048 -validity 10000 -alias jltg`, wire it into
> `android/app/build.gradle`'s `signingConfigs`, and `./gradlew assembleRelease`.
> **Never commit the `.jks`** — it's git-ignored.

---

## No-connection fallback

If the phone has no signal at launch, the WebView can't reach `server.url` and
Capacitor loads the bundled `offline.html` (via `server.errorPath`). It explains
the app needs a connection, lists the reload steps, and its **Reload** button
retries the remote site. It is fully self-contained (no remote assets) because
it's exactly the thing that renders when remote is unreachable.

---

## Manual QA checklist (Phase 39 has no automated tests — it's a native shell)

- [ ] APK installs and opens without a blank screen.
- [ ] The map, zones, questions, stations, and live-share all work as in the PWA.
- [ ] Airplane mode at launch → the offline screen shows; Reload recovers once
      connectivity is back.
- [ ] The blue self-dot + "📍 Location on" chip appear once location is granted.

Record the result of this checklist in the Phase 39 commit message.

---

## What's next (background track)

Phase 39 is just the container. The background notifications that are the point
of the Android app attach to this shell in later phases:

- **Phase 40** — real-phone spike: do the free background plugins fire in Doze?
  **PASS** (`docs/PHASE40_RESULTS.md`) — the foreground service survives Doze.
- **Phase 41** — hider background geofence: rides the foreground-service watcher,
  computes the band in JS (`evaluateGeofence`), fires local notifications. Code +
  tests done; device QA in `docs/PHASE41_HIDER_GEOFENCE.md`.
- **Phases 42–44** — seeker background streaming + FCM forward → hider computes.
- **Phase 45** — the permissions setup wizard (fills the Guide's Android section).

Those need **"Allow all the time"** location and a **battery-optimization
exemption**; the Phase 45 wizard will detect and deep-link to them.
