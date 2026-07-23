# Phase 43 — FCM plumbing (Track B 2/3)

**Status:** code + headless tests committed (server registry + FCM wrapper +
client token acquisition, 22 tests). The **Firebase project + key are a one-time
manual dev setup** (below) — no code creates accounts or handles credentials.

## What this phase does

Stands up Firebase Cloud Messaging end-to-end *plumbing* so Phase 44 can forward
seeker pings to a LOCKED hider:

- **Client** (`src/native-push.js`): on the Android shell the hider mints its FCM
  device token via `@capacitor/push-notifications`; `LiveShare.startAsHider`
  emits `register-token {code, token}` to the relay. Off-device it's a no-op.
- **Server** (`hider-tokens.js`, `fcm.js`, `server.js`): a `register-token`
  socket handler stores `sessionCode → hiderToken` in an expiring registry (no
  game state — a token is a delivery address, not a location); a disconnect drops
  it. `createFcm` initialises `firebase-admin` from a service-account key in an
  **env var** and can send a high-priority data message to a token.

Everything **degrades gracefully**: `firebase-admin` is lazy-imported and
optional, and a missing/broken key disables FCM while the Overpass proxy and the
socket relay keep working. `npm test` never needs the dependency (tests inject a
fake admin).

No forwarding yet — Phase 44 adds the send-on-ping and the receive→local-notify.

## Manual half — one-time developer setup

1. **Create a Firebase project** (free) at <https://console.firebase.google.com>.
   Add an Android app with the package id `com.pachisiav11.jltg` (match
   `capacitor.config.ts`). Download **`google-services.json`** into
   `android/app/`. It is git-ignored — never commit it.
2. **Add the client plugin:** `npm i @capacitor/push-notifications`, then
   `npx cap sync android`. Ensure the app's Gradle applies the Google Services
   plugin (Capacitor/Firebase docs).
3. **Server credential (env var, never committed):**
   - In the Firebase console → Project settings → Service accounts → **Generate
     new private key** → download the JSON.
   - On the Render **web service**, set `FIREBASE_SERVICE_ACCOUNT` to that JSON.
     Because Render env vars mangle the private key's embedded newlines, paste it
     **base64-encoded** — `createFcm`'s `parseServiceAccount` accepts raw JSON or
     base64. Generate with: `base64 -w0 serviceAccount.json` (Linux) /
     `base64 -i serviceAccount.json` (macOS).
   - Install the server dep on Render: `firebase-admin` is in
     `optionalDependencies`; ensure the build runs a plain `npm install` (it
     will) so it's present. The server logs `[fcm] initialized for project …`
     when it's live, or `native push disabled` when the key is absent.
4. Verify: server log shows `native push enabled`; a hider on the APK, after
   joining a session, causes a `register-token` to be stored (add a temporary log
   in the handler if you want to confirm, or wait for the Phase 44 end-to-end).

## Security

- The service-account key lives **only** in `FIREBASE_SERVICE_ACCOUNT` on Render.
- `.gitignore` blocks `google-services.json`, `firebase-service-account*.json`,
  and `serviceAccount*.json` anywhere in the tree, in addition to the whole
  git-ignored `android/`.

## Files

- `hider-tokens.js` — `HiderTokenRegistry` (code→token, TTL, precise drop) + validators.
- `fcm.js` — `createFcm` (graceful admin init from env) + `parseServiceAccount`.
- `src/native-push.js` — `getHiderPushToken` (native-only token acquisition).
- `src/live-share.js` — `getPushToken` option; `startAsHider` registers the token.
- `server.js` — lazy firebase-admin import, registry, `register-token` +
  `disconnect` handlers, hourly prune.
- `src/app.js` — pass `getPushToken` into `LiveShare`.
- `test/fcm-token-registry.test.mjs`, `test/native-push.test.mjs` — 22 tests.
- `package.json` — `firebase-admin` (optional), `@capacitor/push-notifications` (dev).
- SW cache → **v104** (new shell asset `src/native-push.js`).
