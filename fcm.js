// Phase 43 (Track B 2/3): the Firebase Cloud Messaging sender wrapper.
//
// Kept off server.js (importable without booting the listener) and, crucially,
// DEGRADES GRACEFULLY: the whole native-push feature is a one-time developer
// setup (a Firebase project + a service-account key in a Render env var), and the
// server must run perfectly well without it — the Overpass proxy and the socket
// relay have nothing to do with FCM. So a missing/broken key does NOT crash the
// server; it logs once and every send becomes a no-op that reports {ok:false}.
//
// The service-account JSON is read from an ENV VAR (never committed — see
// .gitignore and docs/ANDROID_BUILD.md). firebase-admin is a heavy optional
// dependency, so server.js imports it lazily and hands it in here; if it isn't
// installed, `admin` is null and this wrapper is simply disabled. That also keeps
// `npm test` free of the dependency — the tests inject a fake admin.

// Parse the service-account JSON from the env var. Accepts either raw JSON or a
// base64-encoded blob (Render env vars mangle embedded newlines in the private
// key, so base64 is the safe way to paste it). Returns the object or null.
export function parseServiceAccount(raw) {
  if (!raw || typeof raw !== "string" || !raw.trim()) return null;
  const text = raw.trim();
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  // Raw JSON first; then base64 → JSON.
  let obj = tryParse(text);
  if (!obj) {
    try { obj = tryParse(Buffer.from(text, "base64").toString("utf8")); } catch { obj = null; }
  }
  if (!obj || typeof obj !== "object" || !obj.project_id || !obj.private_key) return null;
  return obj;
}

// Build the FCM sender. `admin` is the firebase-admin module (injected by
// server.js after a lazy import, or a fake in tests). `serviceAccountRaw` is the
// env-var string. `logger` is injectable so a test can assert the one-time log.
//
// Returns { enabled, sendData }. `sendData(token, data)` sends a HIGH-PRIORITY
// DATA message (Phase 44 wakes a locked hider with it) and resolves to:
//   { ok: true }                              — delivered to FCM
//   { ok: false, reason: "disabled" }         — no key / no admin (feature off)
//   { ok: false, reason: "invalid-token" }    — empty/missing token
//   { ok: false, reason, drop: true }         — token no longer registered → the
//                                               caller should evict it from the
//                                               registry
//   { ok: false, reason, error }              — transient send failure (logged)
export function createFcm({ admin = null, serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT, logger = console } = {}) {
  const account = parseServiceAccount(serviceAccountRaw);
  let app = null;
  let enabled = false;

  if (!admin) {
    logger.log?.("[fcm] firebase-admin not available — native push disabled (socket relay still works).");
  } else if (!account) {
    logger.log?.("[fcm] no valid FIREBASE_SERVICE_ACCOUNT env var — native push disabled (socket relay still works).");
  } else {
    try {
      app = admin.initializeApp({ credential: admin.credential.cert(account) }, "jltg-fcm");
      enabled = true;
      logger.log?.(`[fcm] initialized for project ${account.project_id} — native push enabled.`);
    } catch (e) {
      logger.error?.("[fcm] initializeApp failed — native push disabled:", e?.message || e);
    }
  }

  // Shared send path — both sendData and sendNotification funnel through this
  // so the token-validity checks and the "dead token → tell the caller to
  // evict it" mapping stay in exactly one place.
  async function _send(token, message, logLabel) {
    if (!enabled) return { ok: false, reason: "disabled" };
    if (typeof token !== "string" || !token.trim()) return { ok: false, reason: "invalid-token" };
    try {
      await admin.messaging(app).send({ token: token.trim(), ...message });
      return { ok: true };
    } catch (e) {
      const code = e?.code || e?.errorInfo?.code || "";
      // The token is dead (app uninstalled / token rotated) — tell the caller to
      // evict it so we stop trying.
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        return { ok: false, reason: code, drop: true };
      }
      logger.warn?.(`[fcm] ${logLabel} send failed:`, e?.message || e);
      return { ok: false, reason: code || "send-failed", error: e };
    }
  }

  async function sendData(token, data = {}) {
    // Data-only, high priority: a data message with priority "high" wakes the
    // app from Doze so native-push.js (Phase 44) can update the dot/pill. All
    // values must be strings (FCM data contract).
    const stringData = {};
    for (const [k, v] of Object.entries(data)) stringData[k] = String(v);
    return _send(token, { data: stringData, android: { priority: "high" } }, "data");
  }

  // Phase 51: a REAL notification message (title/body in `notification`, not
  // just `data`) — Android's Play Services layer displays this from the
  // system tray on its own, with NO app code required, even if the app
  // process is fully dead. This is what makes the seeker-close alert reach a
  // hider whose phone has been locked long enough for the OS to kill the
  // WebView outright, which a data-only message (needs the JS bridge alive
  // to react to it) cannot guarantee. `channelId` reuses the exact Android
  // notification channel native-local-notify.js's own local alert would have
  // used, so the sound/vibration policy (Off/silent/vibrate/vibrate-tone,
  // already decided by the CALLER before choosing whether to send at all) is
  // consistent regardless of which path actually delivered the alert.
  async function sendNotification(token, { title, body, channelId, data = {} } = {}) {
    const stringData = {};
    for (const [k, v] of Object.entries(data)) stringData[k] = String(v);
    return _send(token, {
      notification: { title: String(title || ""), body: String(body || "") },
      data: stringData,
      android: { priority: "high", notification: channelId ? { channelId } : undefined },
    }, "notification");
  }

  return { enabled, sendData, sendNotification };
}
