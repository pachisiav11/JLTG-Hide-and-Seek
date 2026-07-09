# Phase 14 — Rebuild the Android APK (runbook)

> **Status: BLOCKED — cannot be completed in this environment.** Rebuilding the APK
> needs (1) the app **live on Render** at its `*.onrender.com` URL, (2) the Android
> toolchain (JDK + Android SDK + Bubblewrap), (3) a signing keystore, and (4) a
> physical device to sanity-test. None of those exist here, and fabricating an APK or
> bumping the version pill without a real build would misreport the outcome. This
> runbook makes the rebuild **turnkey once the app is deployed** — it is a re-point of
> the existing thin TWA wrapper, not a re-author.

The current [download/JLTG.apk](download/JLTG.apk) (~1.1 MB) is a **thin TWA wrapper**
that just loads the hosted PWA in an installed shell. Phase 14 rebuilds it against the
new Render URL instead of the old GitHub Pages URL. Same manifest/icons/theme — a
re-point, not a redesign.

---

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
