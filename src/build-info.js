// Phase 50 (req #6): a short, glanceable build stamp for the Instructions
// sheet so a tester can confirm they're actually running the version being
// worked on — deliberately NOT "the latest commit in the repo" (that's
// meaningless to someone looking at their phone), but whatever the site they
// loaded was actually built from. Render supplies RENDER_GIT_COMMIT to every
// build automatically (scripts/build-config.js reads it), so this updates
// itself on every deploy with no manual bump to remember.
//
// Both helpers are pure so the exact display text is unit-tested without a
// DOM or a real deploy.

// First 7 chars of a git SHA, or null for anything that isn't a real commit
// (unset locally, or Render's static-site builds that predate this var).
export function shortCommit(commit) {
  const c = typeof commit === "string" ? commit.trim() : "";
  return c ? c.slice(0, 7) : null;
}

// The line shown at the bottom of Settings ▸ Instructions. `builtAt` is an
// ISO timestamp (or anything Date can parse); an unparsable/missing one
// degrades to an honest "unknown build time" rather than "Invalid Date".
export function formatBuildStamp({ buildId, builtAt } = {}) {
  const id = typeof buildId === "string" && buildId.trim() ? buildId.trim() : "dev";
  const when = builtAt != null ? new Date(builtAt) : null;
  const stamp = when && !Number.isNaN(when.getTime())
    ? `${when.toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "unknown build time";
  return `Build ${id} · ${stamp}`;
}
