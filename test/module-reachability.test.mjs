// Every module in src/ must be reachable from the app.
//
// This exists because of a real failure. `src/station-import.js` shipped in v2 Phase 3 with
// 22 passing tests and **nothing in the app importing it**: the parser was correct and the
// feature did not exist, because no UI ever called it. A player could not import a station
// list. It was caught only by a manual audit after the phase was pushed.
//
// The lesson is that a green suite proves a module CORRECT and says nothing about whether it
// is CONNECTED. Those are separate properties, and only one of them had a check. This is the
// other one.
//
// The test walks the real import graph from the app's entry point rather than grepping for
// filenames, so it follows both static `import` and the dynamic `await import()` the sheets
// use for code-splitting — the exact mechanism the station importer is wired through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;
const ENTRY = "app.js";

// Modules allowed to be unreachable from the app, each with a reason. An allowlist rather
// than a blanket skip: adding to it should feel like a decision, because "nothing imports
// this" is normally a bug, not a design.
const INTENTIONALLY_UNREACHABLE = {
  // A test fixture and a future post-game debrief tool. Deliberately NOT wired into live
  // answering — IMPROVEMENTS.md records that auto-answer was tried and removed on purpose,
  // and MAPPER_ANALYSIS §10.6 keeps it that way.
  "oracle.js": "test fixture / future debrief tool; must never be a live answering path",
};

function listModules() {
  const out = [];
  const walk = (dir, prefix = "") => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
      else if (e.name.endsWith(".js")) out.push(`${prefix}${e.name}`);
    }
  };
  walk(SRC);
  return out;
}

// Both forms the app uses: `import x from "./y.js"` and `await import("./y.js")`.
const IMPORT_RE = /(?:from|import)\s*\(?\s*["'](\.\/[^"']+\.js)["']/g;

function importsOf(rel) {
  let text;
  try { text = readFileSync(join(SRC, rel), "utf8"); }
  catch { return []; }
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
  const found = new Set();
  for (const m of text.matchAll(IMPORT_RE)) {
    // Resolve "./x.js" relative to the importing module's own directory.
    let target = m[1].replace(/^\.\//, "");
    if (dir && !target.startsWith("../")) {
      // A sibling import inside a subdirectory resolves within that subdirectory first.
      const sibling = dir + target;
      found.add(listModules().includes(sibling) ? sibling : target);
    } else {
      found.add(target.replace(/^\.\.\//, ""));
    }
  }
  return [...found];
}

function reachableFrom(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of importsOf(cur)) if (!seen.has(next)) queue.push(next);
  }
  return seen;
}

test("every src/ module is reachable from app.js", () => {
  const all = listModules();
  const reachable = reachableFrom(ENTRY);
  const orphans = all.filter((m) => !reachable.has(m) && !(m in INTENTIONALLY_UNREACHABLE));

  assert.deepEqual(
    orphans, [],
    `These modules are not imported by anything the app loads, so their features do not exist ` +
    `for a player no matter how well tested they are:\n  ${orphans.join("\n  ")}\n` +
    `Either wire the module up, or add it to INTENTIONALLY_UNREACHABLE with a reason.`,
  );
});

test("the entry point itself resolves and pulls in the core modules", () => {
  // Guards the walker rather than the app: a regex that silently matched nothing would make
  // the test above pass vacuously with every module reported as an orphan-free graph of one.
  const reachable = reachableFrom(ENTRY);
  for (const core of ["tools.js", "layers.js", "store.js", "geo.js", "model.js"]) {
    assert.ok(reachable.has(core), `${core} must be reachable — the import walker is broken if not`);
  }
  assert.ok(reachable.size > 15, `expected a real graph, walked only ${reachable.size} modules`);
});

// The specific regression. Each of these is a v2 feature whose module could plausibly be
// left unwired again by a refactor that removes its only call site.
test("the v2 feature modules are wired to real call sites", () => {
  const reachable = reachableFrom(ENTRY);
  for (const [mod, feature] of [
    ["hiding-zones.js", "hiding-zone survival, render styles and drill-down"],
    ["station-import.js", "CSV / GeoJSON / KML station import"],
    ["net.js", "request de-duplication and proxy failover"],
    ["share-link.js", "share a game in a URL"],
  ]) {
    assert.ok(reachable.has(mod), `${mod} is orphaned — ${feature} would not exist for a player`);
  }
});

test("every allowlisted module carries a reason, and still exists", () => {
  const all = listModules();
  for (const [mod, reason] of Object.entries(INTENTIONALLY_UNREACHABLE)) {
    assert.ok(all.includes(mod), `${mod} is allowlisted but no longer exists — drop the entry`);
    assert.ok(reason && reason.length > 20, `${mod} needs a real reason, not a placeholder`);
  }
});
