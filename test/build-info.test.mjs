// Phase 50 (req #6): the Instructions build stamp — lets a tester confirm
// which push they're actually running (not "the latest commit in the repo",
// which means nothing on a phone), via whatever RENDER_GIT_COMMIT the site
// was actually built from.
import test from "node:test";
import assert from "node:assert/strict";
import { shortCommit, formatBuildStamp } from "../src/build-info.js";

test("shortCommit trims a full SHA to 7 chars", () => {
  assert.equal(shortCommit("c54a12c9f3a1b2d3e4f5a6b7c8d9e0f1a2b3c4d5"), "c54a12c");
});

test("shortCommit is null for unset/blank/non-string input", () => {
  assert.equal(shortCommit(undefined), null);
  assert.equal(shortCommit(""), null);
  assert.equal(shortCommit("   "), null);
  assert.equal(shortCommit(42), null);
});

test("formatBuildStamp renders id + a UTC-minute timestamp", () => {
  const s = formatBuildStamp({ buildId: "c54a12c", builtAt: "2026-07-26T14:03:27.123Z" });
  assert.equal(s, "Build c54a12c · 2026-07-26 14:03 UTC");
});

test("formatBuildStamp falls back to 'dev' when there's no real build id (local dev)", () => {
  const s = formatBuildStamp({ builtAt: "2026-07-26T14:03:00.000Z" });
  assert.match(s, /^Build dev · /);
});

test("formatBuildStamp degrades honestly instead of 'Invalid Date' for a missing/bad timestamp", () => {
  assert.match(formatBuildStamp({ buildId: "abc1234" }), /unknown build time$/);
  assert.match(formatBuildStamp({ buildId: "abc1234", builtAt: "not-a-date" }), /unknown build time$/);
});

test("formatBuildStamp with nothing at all is still a sane string, never throws", () => {
  assert.doesNotThrow(() => formatBuildStamp());
  assert.equal(formatBuildStamp(), "Build dev · unknown build time");
});
