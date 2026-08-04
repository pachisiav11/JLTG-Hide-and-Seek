# Phase 14 — Rebuild the Android APK (runbook)

> **Status: DONE (2026-07-09).** Once the app went live at
> `https://jltg-map-companion.onrender.com`, the toolchain (JDK 21 + Android SDK +
> Bubblewrap 1.24) turned out to be present on this machine, so the APK was actually
> rebuilt and re-signed against the Render URL. [download/JLTG.apk](download/JLTG.apk)
> now points at `jltg-map-companion.onrender.com` (was `pachisiav11.github.io`),
> packageId `app.web.jltg.twa`, versionName **1.1.0** / versionCode 3, signed and
> verified (apksigner v1/v2/v3 = true). Digital Asset Links were added at
> [.well-known/assetlinks.json](.well-known/assetlinks.json) so the TWA verifies as a
> fullscreen app once deployed. **The physical-device sanity check (step 7) is still
> the developer's to do.**
>
> **Signing key (KEEP SAFE — not in git):** `C:\Users\vihaa\jltg-twa-build\android.keystore`,
> alias `android`. SHA-256 `1A:CF:B3:54:56:93:E8:4B:39:83:23:52:70:5E:04:BA:B3:33:A5:91:31:BE:E3:45:76:6E:D4:D5:44:C0:59:04`.
> Reuse this exact keystore for future updates so they install over v1.1.0 without an
> uninstall. This is a NEW key vs the old GitHub-Pages APK, so testers must **uninstall
> the old app first**. The `assetlinks.json` fingerprint must match whatever key ships.
>
> ---
>
> *Original blocker note (now resolved), kept for context:* Rebuilding the APK needs
> (1) the app **live on Render**, (2) the Android toolchain, (3) a signing keystore,
> and (4) a device to sanity-test. (1)–(3) were satisfied; (4) remains manual. This
> runbook is a re-point of the existing thin TWA wrapper, not a re-author.

The current [download/JLTG.apk](download/JLTG.apk) (~1.1 MB) is a **thin TWA wrapper**
that just loads the hosted PWA in an installed shell. Phase 14 rebuilds it against the
new Render URL instead of the old GitHub Pages URL. Same manifest/icons/theme — a
re-point, not a redesign.

---

## v2 — do you actually need to rebuild? (2026-08-04)

**Usually no.** The APK is a *thin TWA wrapper*: it contains **no app code**, it just opens
`https://jltg-map-companion.onrender.com` in an installed shell. So a Render deploy is picked
up by the **existing** APK the next time it launches — the v2 build reaches the phone without
any APK work at all. The service worker handles the shell update, and the app shows its
"New version available — Reload" banner.

A rebuild is needed **only** when one of these changes:

| Change | Rebuild? | Why |
|---|---|---|
| New code deployed to Render | **No** | the TWA loads it live |
| The Render **host** changed | **Yes** | the host is baked into the TWA manifest |
| App name / icons / theme colour | Yes | baked into the APK |
| `packageId` or signing key | Yes | and testers must uninstall first |

So before rebuilding, check the host. The repo currently references three, and only the first
is the live app:

- `jltg-map-companion.onrender.com` — what the shipped APK points at
- `jltg-hide-and-seek.onrender.com` — the `render.yaml` service *name*, used as an example in docs
- `jltg-backend.onrender.com` — the backend, never a TWA target

**If the host is still `jltg-map-companion.onrender.com`, there is nothing to rebuild.**

### The thing that DOES need checking after a deploy

Far more likely to break the app on a phone than the APK: the static site's
`OVERPASS_PROXY_URL`. It is read by `scripts/build-config.js` and defaults to `""`. Until v2 it
was not even declared in `render.yaml`, so a deploy could ship with **no OpenStreetMap access**
— 🚄 Rail drawing nothing, coastline/borders unsourceable, the Station's Line card refusing,
and the peak/brand cards silently falling back to Google's name search.

It is now declared in `render.yaml` (`sync: false`, so set it in the dashboard) and
`build-config.js` prints a loud warning in the Render **build log** when it is missing on a
deploy. After any deploy, confirm in the browser console:

```js
window.JLTG_CONFIG.OVERPASS_PROXY_URL   // should be the backend URL, not ""
window.JLTG_CONFIG.BUILD_ID             // should be the short commit you just deployed
```

### Confirming which build the phone has, without a console

Remote-debugging a phone to read `BUILD_ID` is a lot of ceremony for one string, and it does
not work at all when the app will not start. Open **`/version.html`** on the device instead
(also linked from Settings ▸ Instructions as *check for updates*).

It imports nothing — no modules, no Maps, no IndexedDB — so it answers even when the app is
white-screening, and it shows the three things that actually distinguish the failures that
look alike:

| What it shows | What it rules out |
|---|---|
| loaded commit vs served commit | a stale cached shell (the app is old, the deploy is fine) |
| backend `/health` commit | front end and backend on different deploys |
| service-worker + cache buckets | something local to this device, cleared by its **Clear caches & reload** |

If the served commit is blank or unreachable while the phone has signal, the *host* is the
problem — which is the case where the APK's baked-in URL is worth re-checking against the
table above. A wrong-host APK and a stale cache produce nearly the same screen; this is how
to tell them apart.

### Toolchain note

The APK cannot be built in the CI/agent sandbox: there is no Android SDK (`sdkmanager`,
`apksigner`, `adb` all absent), Bubblewrap cannot fetch one because outbound network is
restricted, and — decisively — **the signing keystore is not in this repo and must never be**.
It lives on the developer's machine (see the status note above). Building with any other key
produces an APK that will not install over the existing one and whose fingerprint no longer
matches `.well-known/assetlinks.json`, so the TWA would fall back to showing a browser address
bar. Rebuilds are a developer-machine task by design.

## Prerequisites

1. The app is deployed and reachable, e.g. `https://jltg-hide-and-seek.onrender.com`
   (see README ▸ **Deploy to Render**). Call this `$APP_URL`.
2. Node 18+, a JDK (17), and Android SDK build-tools installed. Bubblewrap fetches the
   rest on first run.
3. `npm install -g @bubblewrap/cli` (the same class of tool — Bubblewrap / PWABuilder —
   that produced the current ~1.1 MB wrapper).

## Steps

1. **Point Bubblewrap at the deployed manifest.** From a clean build dir:
   ```bash
   bubblewrap init --manifest "$APP_URL/manifest.webmanifest"
   ```
   Accept the values pulled from [manifest.webmanifest](manifest.webmanifest); they match
   [twa-manifest.template.json](twa-manifest.template.json) in this repo (app name
   "JLTG H&S", `#072129` theme, portrait, icons under `icons/`). Host = the Render host,
   start URL = `/index.html`.

2. **Keep it a thin wrapper.** Do **not** bundle app code into the APK — the TWA loads
   the live Render app and relies on the service worker for the offline shell, exactly
   as the current one does. No app source goes in the APK.

3. **Signing key.** The original keystore is not in this repo. For personal sideloading
   generate one (`keytool -genkey ...`) and keep it safe; note that a new key changes the
   signature, so testers must **uninstall the old app before installing** the new APK.

4. **Build:**
   ```bash
   bubblewrap build       # produces app-release-signed.apk
   ```

5. **Replace the shipped file (same filename so links keep working):**
   ```bash
   cp app-release-signed.apk download/JLTG.apk
   ```

6. **Update [install_guide.html](install_guide.html):** bump the `#apk-meta` version
   pill from `v1.0.0` (e.g. `v1.1.0`), keep the `#apk-link` href as `download/JLTG.apk`,
   and adjust the "Download the Android app" step text only if the install flow changed.

7. **Sanity check on a device:** install the new APK, confirm it opens the
   **Render-hosted** app (not a stale GitHub Pages cache) and that the Maps API-key
   prompt/flow still works end-to-end.

8. **Commit + push** as `Phase 14: rebuild APK against Render URL`.

---

## What's already prepared here

- [twa-manifest.template.json](twa-manifest.template.json) — Bubblewrap config mirroring
  the PWA manifest, with `HOST`/`START_URL` placeholders to fill with `$APP_URL`. Rename
  to `twa-manifest.json` in your build dir (or let `bubblewrap init` generate it from the
  live manifest and cross-check against this).
- `install_guide.html` and `manifest.webmanifest` are already correct for a re-point;
  only the version pill + (implicitly) the hosted URL change.
