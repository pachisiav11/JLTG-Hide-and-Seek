// service-worker.js precaches SHELL_ASSETS with cache.addAll, which is ATOMIC: one entry
// pointing at a file that no longer exists fails the whole install, so the app silently keeps
// serving the previous shell and stops updating. Nothing throws in the page.
//
// Both E2 (i18n.js) and E1 (data/linear.js) deleted precached files, and each time the
// manifest edit was a separate manual step that had to be remembered. This is that step,
// enforced.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sw = readFileSync(root + "service-worker.js", "utf8");

// SHELL_ASSETS is a flat array of "./path" literals; read it out of the source rather than
// importing, since the SW module expects a ServiceWorkerGlobalScope.
function shellAssets() {
  const block = sw.match(/SHELL_ASSETS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(block, "could not find SHELL_ASSETS in service-worker.js");
  return [...block[1].matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
}

test("every precached shell asset exists on disk", () => {
  const missing = shellAssets().filter((rel) => !existsSync(root + rel));
  assert.deepEqual(missing, [], `cache.addAll is atomic — these entries would fail the whole SW install: ${missing.join(", ")}`);
});

test("SHELL_ASSETS has no duplicate entries", () => {
  const list = shellAssets();
  const dupes = list.filter((v, i) => list.indexOf(v) !== i);
  assert.deepEqual(dupes, [], `duplicate precache entries: ${dupes.join(", ")}`);
});

test("deleted modules are not still precached", () => {
  // The two this suite was written for, named explicitly so a revert is loud.
  const list = shellAssets();
  for (const gone of ["src/i18n.js", "src/langs/en.js", "src/data/linear.js"]) {
    assert.ok(!list.includes(gone), `${gone} was deleted but is still in SHELL_ASSETS`);
  }
});
