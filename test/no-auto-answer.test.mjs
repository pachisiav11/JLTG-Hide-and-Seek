// The companion never answers its own questions. A human does.
//
// This is a standing product decision, not a preference: auto-answer was built once, removed
// deliberately (CHANGELOG Phase 5 → the removal), and reaffirmed every time the subject has
// come up since. The failure mode it prevents is specific and nasty — a computed answer is
// confident, instant, and indistinguishable from a correct one, so when the geometry is
// subtly wrong (a mis-sourced coastline, a station 3 km from the hider, an elevation the map
// cannot know) the app eliminates the square the hider is standing in and everyone believes
// it. A human answering from the ground gets that right by construction.
//
// The decision keeps needing re-enforcement because the capability is genuinely useful in
// TESTING: test/oracle.js derives truthful answers so the suite can assert the hider is never
// eliminated. That file has to exist, and it is one import away from becoming a feature. So
// this test guards the boundary rather than the intent.
//
// It checks three separate things, because they fail independently:
//
//   1. no module under src/ imports the oracle (the direct route)
//   2. the oracle is not IN src/ at all             (so it cannot be imported by accident)
//   3. nothing under src/ defines its own answer-deriving function
//                                                   (the route that skips the oracle entirely)
//
// There is deliberately no allowlist. An exception here would defeat the whole point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const SRC = join(ROOT, "src");

function srcFiles(dir = SRC, prefix = "") {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...srcFiles(join(dir, e.name), `${prefix}${e.name}/`));
    else if (e.name.endsWith(".js")) out.push({ rel: `src/${prefix}${e.name}`, abs: join(dir, e.name) });
  }
  return out;
}

test("the oracle does not live in the app's source tree", () => {
  // Being in src/ is not harmless even when unimported: it ships to every device as a
  // fetchable module, it is what a refactor reaches for first, and it reads as app code to
  // anyone opening the folder. Keeping it in test/ makes the boundary structural.
  assert.ok(!existsSync(join(SRC, "oracle.js")),
    "src/oracle.js is back. The answer-deriving oracle belongs in test/ — the app must not " +
    "carry the ability to answer its own questions.");
  assert.ok(existsSync(join(ROOT, "test", "oracle.js")),
    "test/oracle.js is missing — the hider-survival suite depends on it.");
});

test("nothing in src/ imports the oracle", () => {
  // Matches any path ending in oracle.js: "./oracle.js", "../test/oracle.js", "/test/oracle.js".
  const importsOracle = /(?:from|import)\s*\(?\s*["'][^"']*oracle\.js["']/;
  const offenders = srcFiles()
    .filter(({ abs }) => importsOracle.test(readFileSync(abs, "utf8")))
    .map(({ rel }) => rel);

  assert.deepEqual(offenders, [],
    `These app modules import the answer oracle:\n  ${offenders.join("\n  ")}\n` +
    `The companion must never compute an answer — not to show it, not to pre-fill it, and ` +
    `not to compare it against what the player entered. Answers come from a human.`);
});

test("nothing in src/ defines its own answer-deriving function", () => {
  // The oracle is the obvious route; re-implementing it inside a module is the quiet one.
  // Name-based, so it is a tripwire rather than a proof — but it catches the names anyone
  // would actually reach for, including the reference mapper's own `hiderify*`.
  const BANNED = /\b(truthfulAnswer|autoAnswer|deriveAnswer|computeAnswer|computedTruth|hiderify\w*)\b/;
  const offenders = [];
  for (const { rel, abs } of srcFiles()) {
    for (const [i, line] of readFileSync(abs, "utf8").split("\n").entries()) {
      // Comments may name these freely — several explain why they are absent, and a rule
      // that punished explaining itself would get the explanations deleted.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (BANNED.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [],
    `Answer-deriving code found in the app:\n  ${offenders.join("\n  ")}\n` +
    `Computing the answer is the thing being prevented, whatever it is then used for.`);
});

test("the oracle is not shipped in the offline shell", () => {
  // The service worker's asset list is the other place a module can quietly become part of
  // the app — precached on every device, ready to import.
  const sw = readFileSync(join(ROOT, "service-worker.js"), "utf8");
  assert.ok(!/oracle\.js/.test(sw),
    "service-worker.js caches oracle.js — the answer engine must not ship with the app shell.");
});
