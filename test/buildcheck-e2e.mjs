// End-to-end check of the build-version feature in a real browser.
//
// The unit tests cover the comparison logic. What they cannot cover is the thing the user
// actually warned about: that adding a network probe to startup must not break an app whose
// network is already unreliable. So this drives the real page, with the real service worker,
// under three conditions — matching build, mismatched build, and version.json missing
// entirely — and asserts the app still boots in all three.
//
// Not part of `npm test`: it needs Playwright and a Chromium, neither of which the unit
// suite depends on. Run it directly —
//
//   node test/buildcheck-e2e.mjs
//
// It writes a throwaway config.js into the repo root (git-ignored) and leaves it there;
// delete it afterwards if you keep a real one locally.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const PORT = 8123;

// version.json is served from memory so a test can change the "deployed" commit between
// loads without touching the working tree.
let deployedVersion = { commit: "abc1234", fullCommit: "abc1234def", builtAt: "2026-08-04T10:00:00.000Z" };
let serveVersion = true;
const versionRequests = [];

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json",
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);

  if (path === "/version.json") {
    versionRequests.push(url.search);
    if (!serveVersion) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(deployedVersion));
  }

  const file = join(ROOT, path === "/" ? "index.html" : path);
  if (!existsSync(file) || !file.startsWith(ROOT)) { res.writeHead(404); return res.end("not found"); }
  try {
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  } catch { res.writeHead(500); res.end("err"); }
});

// A config.js whose BUILD_ID the tests control, standing in for what Render bakes in.
function writeConfig(buildId) {
  writeFileSync(join(ROOT, "config.js"), `window.JLTG_CONFIG = {
  GOOGLE_MAPS_API_KEY: "",
  MAP_ID: "",
  DEFAULT_CENTER: { lat: 1.283, lng: 103.859 },
  DEFAULT_ZOOM: 12,
  OVERPASS_PROXY_URL: "",
  MULTIPLAYER_URL: "",
  BUILD_ID: ${JSON.stringify(buildId)},
  BUILT_AT: "2026-08-01T09:00:00.000Z",
};
`, "utf8");
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

await new Promise((r) => server.listen(PORT, r));
const browser = await chromium.launch();

async function newPage() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Google Maps cannot load here; stub it so the app boots far enough to be judged.
  await page.addInitScript(() => {
    const stub = new Proxy(function () {}, {
      get: () => stub, apply: () => stub, construct: () => stub,
    });
    window.google = { maps: stub };
  });
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message}`));
  return { ctx, page, logs };
}

// --- 1. matching build: no banner, and the app is untouched -------------------
{
  writeConfig("abc1234");
  deployedVersion = { commit: "abc1234", fullCommit: "abc1234def", builtAt: "2026-08-04T10:00:00.000Z" };
  const { ctx, page, logs } = await newPage();
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "load" });
  await page.waitForTimeout(4000);

  const banner = await page.locator("#build-banner").count();
  check("match: no banner shown", banner === 0, `banner count ${banner}`);
  check("match: verdict logged", logs.some((l) => /\[build\] Running the deployed build \(abc1234\)/.test(l)),
    logs.filter((l) => l.includes("[build]")).join(" | ") || "no [build] log");
  check("match: probe defeated caches", versionRequests.some((q) => /^\?t=\d+$/.test(q)),
    JSON.stringify(versionRequests.slice(-2)));
  await ctx.close();
}

// --- 2. mismatched build: banner names BOTH commits ---------------------------
{
  writeConfig("abc1234");
  deployedVersion = { commit: "9f8e7d6", fullCommit: "9f8e7d6c5b", builtAt: "2026-08-04T12:00:00.000Z" };
  const { ctx, page, logs } = await newPage();
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "load" });
  await page.waitForSelector("#build-banner", { timeout: 15000 }).catch(() => {});

  const text = await page.locator("#build-banner").textContent().catch(() => "");
  check("mismatch: banner appears", !!text, text || "no banner");
  check("mismatch: banner names the loaded commit", /abc1234/.test(text || ""), text);
  check("mismatch: banner names the deployed commit", /9f8e7d6/.test(text || ""), text);
  check("mismatch: reload button present", await page.locator("#bb-reload").count() === 1);

  // Dismiss must actually dismiss — a banner you cannot get rid of mid-game is worse
  // than the staleness it reports.
  await page.locator("#build-banner .update-x").click();
  await page.waitForTimeout(300);
  check("mismatch: dismiss removes the banner", await page.locator("#build-banner").count() === 0);
  check("mismatch: no page errors", !logs.some((l) => l.startsWith("PAGEERROR")),
    logs.filter((l) => l.startsWith("PAGEERROR")).join(" | "));
  await ctx.close();
}

// --- 3. version.json missing (any host deployed before this change) -----------
{
  writeConfig("abc1234");
  serveVersion = false;
  const { ctx, page, logs } = await newPage();
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "load" });
  await page.waitForTimeout(4000);

  check("missing: no banner", await page.locator("#build-banner").count() === 0);
  check("missing: reported as uncomparable, not stale",
    logs.some((l) => /\[build\].*could not reach/.test(l)),
    logs.filter((l) => l.includes("[build]")).join(" | ") || "no [build] log");
  check("missing: app still boots", await page.locator("#map").count() > 0);
  check("missing: no page errors", !logs.some((l) => l.startsWith("PAGEERROR")),
    logs.filter((l) => l.startsWith("PAGEERROR")).join(" | "));
  await ctx.close();
  serveVersion = true;
}

// --- 4. the standalone diagnostic page ----------------------------------------
{
  writeConfig("abc1234");
  deployedVersion = { commit: "9f8e7d6", fullCommit: "9f8e7d6c5b", builtAt: "2026-08-04T12:00:00.000Z" };
  const { ctx, page, logs } = await newPage();
  await page.goto(`http://localhost:${PORT}/version.html`, { waitUntil: "load" });
  await page.waitForFunction(() => !/Checking/.test(document.getElementById("verdict").textContent), null, { timeout: 15000 });

  const verdict = await page.locator("#verdict").textContent();
  check("version.html: reports out of date", /OUT OF DATE/.test(verdict), verdict);
  check("version.html: names both commits", /abc1234/.test(verdict) && /9f8e7d6/.test(verdict), verdict);
  check("version.html: shows the full SHA", (await page.locator("#dep-full").textContent()) === "9f8e7d6c5b");
  check("version.html: reports SW state", (await page.locator("#sw-state").textContent()).length > 1);
  check("version.html: no page errors", !logs.some((l) => l.startsWith("PAGEERROR")),
    logs.filter((l) => l.startsWith("PAGEERROR")).join(" | "));

  // Re-check must re-ask the network rather than reuse anything.
  const before = versionRequests.length;
  await page.locator("#recheck").click();
  await page.waitForTimeout(1200);
  check("version.html: re-check re-fetches", versionRequests.length > before,
    `${before} -> ${versionRequests.length}`);
  await ctx.close();
}

// --- 5. version.html works when the app itself is broken ----------------------
{
  // The whole reason this page has no imports. Break the app's entry point and confirm
  // the diagnostic still answers — that is the scenario it was built for.
  writeConfig("abc1234");
  deployedVersion = { commit: "9f8e7d6", fullCommit: "9f8e7d6c5b", builtAt: "2026-08-04T12:00:00.000Z" };
  const { ctx, page } = await newPage();
  await page.route("**/src/app.js", (route) => route.fulfill({ status: 500, body: "boom" }));
  await page.goto(`http://localhost:${PORT}/version.html`, { waitUntil: "load" });
  await page.waitForFunction(() => !/Checking/.test(document.getElementById("verdict").textContent), null, { timeout: 15000 });
  const verdict = await page.locator("#verdict").textContent();
  check("broken app: diagnostic still reports a verdict", /OUT OF DATE/.test(verdict), verdict);
  await ctx.close();
}

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
