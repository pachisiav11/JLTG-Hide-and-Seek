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

  async function sendData(token, data = {}) {
    if (!enabled) return { ok: false, reason: "disabled" };
    if (typeof token !== "string" || !token.trim()) return { ok: false, reason: "invalid-token" };
    try {
      // Data-only, high priority: a data message with priority "high" wakes the
      // app from Doze so native-push.js (Phase 44) can run evaluateApproach and
      // post a LOCAL notification. All values must be strings (FCM data contract).
      const stringData = {};
      for (const [k, v] of Object.entries(data)) stringData[k] = String(v);
      await admin.messaging(app).send({
        token: token.trim(),
        data: stringData,
        android: { priority: "high" },
      });
      return { ok: true };
    } catch (e) {
      const code = e?.code || e?.errorInfo?.code || "";
      // The token is dead (app uninstalled / token rotated) — tell the caller to
      // evict it so we stop trying.
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        return { ok: false, reason: code, drop: true };
      }
      logger.warn?.("[fcm] send failed:", e?.message || e);
      return { ok: false, reason: code || "send-failed", error: e };
    }
  }

  return { enabled, sendData };
}
