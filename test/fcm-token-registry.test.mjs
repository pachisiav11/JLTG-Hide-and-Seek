// Phase 43 (Track B 2/3) test: the hider-token registry + the FCM sender wrapper.
//
// The Firebase project + service-account key are a one-time MANUAL dev setup, so
// what's pinnable headlessly is the SERVER contract around them:
//   - the registry maps session code → hider token, validates junk out, expires
//     stale entries, and drops precisely (only the matching token),
//   - createFcm DEGRADES GRACEFULLY: no admin or no key → disabled, every send a
//     no-op {ok:false}, the server never crashes,
//   - with a (fake) admin + key it sends a HIGH-PRIORITY DATA message and reports
//     a dead token so the caller can evict it.
// The plan's headline requirement — "a registered token is looked up by code and
// a missing key degrades gracefully (no crash, logs)" — is exactly this file.
import test from "node:test";
import assert from "node:assert/strict";

const { HiderTokenRegistry, isValidToken, normalizeCode } = await import("../hider-tokens.js");
const { createFcm, parseServiceAccount } = await import("../fcm.js");

// A plausible-shaped FCM token (opaque, long, url-safe-ish charset).
const TOKEN = "cZ12_ab:APA91bH" + "x".repeat(120) + "-_.9";
const TOKEN2 = "dQ34_cd:APA91bG" + "y".repeat(120) + "-_.8";

// --- registry --------------------------------------------------------------

test("isValidToken / normalizeCode reject the obvious junk", () => {
  assert.equal(isValidToken(TOKEN), true);
  assert.equal(isValidToken(""), false);
  assert.equal(isValidToken("short"), false);
  assert.equal(isValidToken("has spaces and stuff!!"), false);
  assert.equal(isValidToken(null), false);
  assert.equal(normalizeCode("ABC123"), "abc123");
  assert.equal(normalizeCode("  Ab-9  "), "ab-9");
  assert.equal(normalizeCode("no"), null, "too short");
  assert.equal(normalizeCode("bad code!"), null);
});

test("register then lookup by code returns the token", () => {
  const reg = new HiderTokenRegistry();
  assert.equal(reg.register("Game-01", TOKEN), true);
  assert.equal(reg.lookup("game-01"), TOKEN, "case-insensitive lookup by session code");
  assert.equal(reg.lookup("nope"), null);
  assert.equal(reg.size, 1);
});

test("register rejects an invalid code or token without storing", () => {
  const reg = new HiderTokenRegistry();
  assert.equal(reg.register("x", TOKEN), false, "bad code");
  assert.equal(reg.register("game-01", "junk"), false, "bad token");
  assert.equal(reg.size, 0);
});

test("a newer token overwrites the old one for the same session", () => {
  const reg = new HiderTokenRegistry();
  reg.register("game-01", TOKEN);
  reg.register("game-01", TOKEN2);
  assert.equal(reg.lookup("game-01"), TOKEN2);
});

test("entries expire after the TTL (lazy on lookup)", () => {
  let clock = 1_000_000;
  const reg = new HiderTokenRegistry({ ttlMs: 1000, now: () => clock });
  reg.register("game-01", TOKEN);
  clock += 999;
  assert.equal(reg.lookup("game-01"), TOKEN, "still fresh");
  clock += 2;
  assert.equal(reg.lookup("game-01"), null, "expired → dropped on read");
  assert.equal(reg.size, 0);
});

test("drop is precise — only evicts when the token matches", () => {
  const reg = new HiderTokenRegistry();
  reg.register("game-01", TOKEN);
  assert.equal(reg.drop("game-01", TOKEN2), false, "a stale disconnect must not evict a refreshed token");
  assert.equal(reg.lookup("game-01"), TOKEN);
  assert.equal(reg.drop("game-01", TOKEN), true);
  assert.equal(reg.lookup("game-01"), null);
});

test("prune sweeps expired entries in bulk", () => {
  let clock = 0;
  const reg = new HiderTokenRegistry({ ttlMs: 100, now: () => clock });
  reg.register("aaa1", TOKEN);
  clock = 50;
  reg.register("bbb2", TOKEN2);
  clock = 120; // aaa1 is 120 old (expired), bbb2 is 70 old (fresh)
  assert.equal(reg.prune(), 1);
  assert.equal(reg.lookup("bbb2"), TOKEN2);
});

// --- FCM wrapper -----------------------------------------------------------

const FAKE_ACCOUNT = JSON.stringify({ project_id: "jltg-test", private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n", client_email: "x@y.iam.gserviceaccount.com" });

function silentLogger() {
  const lines = [];
  return { log: (...a) => lines.push(["log", ...a]), warn: (...a) => lines.push(["warn", ...a]), error: (...a) => lines.push(["error", ...a]), lines };
}

// A fake firebase-admin: records send() calls, can be told to throw a given code.
function fakeAdmin({ throwCode = null } = {}) {
  const sent = [];
  const messaging = () => ({
    send: async (msg) => {
      if (throwCode) { const e = new Error("boom"); e.code = throwCode; throw e; }
      sent.push(msg);
      return "projects/x/messages/1";
    },
  });
  return {
    sent,
    credential: { cert: (acct) => ({ _acct: acct }) },
    initializeApp: (opts, name) => ({ opts, name }),
    messaging,
  };
}

test("parseServiceAccount accepts raw JSON and base64, rejects junk", () => {
  assert.equal(parseServiceAccount(FAKE_ACCOUNT).project_id, "jltg-test");
  const b64 = Buffer.from(FAKE_ACCOUNT, "utf8").toString("base64");
  assert.equal(parseServiceAccount(b64).project_id, "jltg-test", "base64 (Render-safe) parses");
  assert.equal(parseServiceAccount(""), null);
  assert.equal(parseServiceAccount("{not json"), null);
  assert.equal(parseServiceAccount(JSON.stringify({ project_id: "x" })), null, "missing private_key → rejected");
});

test("createFcm is DISABLED (no crash) without admin, and every send no-ops", async () => {
  const logger = silentLogger();
  const fcm = createFcm({ admin: null, serviceAccountRaw: FAKE_ACCOUNT, logger });
  assert.equal(fcm.enabled, false);
  assert.deepEqual(await fcm.sendData(TOKEN, { a: 1 }), { ok: false, reason: "disabled" });
  assert.ok(logger.lines.some((l) => String(l[1]).includes("native push disabled")), "logs the degraded state once");
});

test("createFcm is DISABLED without a service-account key", async () => {
  const fcm = createFcm({ admin: fakeAdmin(), serviceAccountRaw: "", logger: silentLogger() });
  assert.equal(fcm.enabled, false);
  assert.equal((await fcm.sendData(TOKEN)).reason, "disabled");
});

test("createFcm ENABLED sends a high-priority DATA message with string values", async () => {
  const admin = fakeAdmin();
  const fcm = createFcm({ admin, serviceAccountRaw: FAKE_ACCOUNT, logger: silentLogger() });
  assert.equal(fcm.enabled, true);
  const res = await fcm.sendData(TOKEN, { lat: 19.076, lng: 72.877, code: "game-01" });
  assert.deepEqual(res, { ok: true });
  assert.equal(admin.sent.length, 1);
  const msg = admin.sent[0];
  assert.equal(msg.token, TOKEN);
  assert.equal(msg.android.priority, "high", "high priority wakes a locked hider");
  assert.equal(msg.data.lat, "19.076", "all data values coerced to strings (FCM contract)");
  assert.equal(msg.data.code, "game-01");
});

test("createFcm reports a dead token so the caller can evict it", async () => {
  const admin = fakeAdmin({ throwCode: "messaging/registration-token-not-registered" });
  const fcm = createFcm({ admin, serviceAccountRaw: FAKE_ACCOUNT, logger: silentLogger() });
  const res = await fcm.sendData(TOKEN, { a: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.drop, true, "an unregistered token signals the registry to drop it");
});

test("createFcm swallows a transient send failure (no throw)", async () => {
  const admin = fakeAdmin({ throwCode: "messaging/server-unavailable" });
  const fcm = createFcm({ admin, serviceAccountRaw: FAKE_ACCOUNT, logger: silentLogger() });
  const res = await fcm.sendData(TOKEN, { a: 1 });
  assert.equal(res.ok, false);
  assert.notEqual(res.drop, true, "a transient failure must NOT evict the token");
});

test("sendData with an empty token is rejected before hitting admin", async () => {
  const admin = fakeAdmin();
  const fcm = createFcm({ admin, serviceAccountRaw: FAKE_ACCOUNT, logger: silentLogger() });
  assert.equal((await fcm.sendData("")).reason, "invalid-token");
  assert.equal(admin.sent.length, 0);
});
