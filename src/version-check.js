// "Am I actually running the build I think I am?"
//
// The APK is a Bubblewrap TWA shell containing no app code, so there is no commit id
// *in the APK* to find — the shell just opens a URL. What has a commit id is the page
// that URL served, and that is what can silently go stale: a service-worker shell from
// an earlier visit, an HTTP-cached module, or a phone that never reloaded after a deploy.
// The symptom is the worst kind: the app looks fine and is simply old.
//
// So the check compares two things that are produced at DIFFERENT times:
//
//   loaded   — window.JLTG_CONFIG.BUILD_ID, baked into config.js when THIS page's
//              assets were built, and therefore as old as whatever served them.
//   deployed — version.json, fetched from the network right now with caching defeated,
//              and therefore what the origin is serving at this instant.
//
// Equal means the page in front of you is the deploy. Different means it is not, and the
// difference names both commits so a developer can tell exactly which one they are on
// without trusting the phone's UI.
//
// Everything here is failure-tolerant by construction. A device that is offline, behind a
// captive portal, or pointed at a host that is down must get "unknown" and no banner —
// never an error, never a blocked startup. A version check that can break the app is worse
// than no version check, and this one runs on devices whose network is the thing in doubt.

// A commit id is only meaningful if it is a real build stamp. "dev" is what
// build-info.js emits when RENDER_GIT_COMMIT is absent (any local build), and an
// empty/missing value means the same thing with less ceremony: no deploy identity.
export function normalizeBuildId(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s || s === "dev" || s === "unknown") return null;
  return s;
}

// Compare the build this page was made from against the build the origin serves now.
//
//   "match"   — same commit; the page is the deploy.
//   "differs" — different commits; the page is NOT the deploy. Deliberately not called
//               "stale": two commit hashes have no order, so all that is honestly known
//               is that they are not the same one. In practice the served copy is the
//               newer one, but the wording should not assert what was not measured.
//   "unknown" — one or both sides have no deploy identity (local dev, or the fetch
//               failed). Not an error state; just nothing to compare.
export function compareBuilds(loaded, deployed) {
  const a = normalizeBuildId(loaded);
  const b = normalizeBuildId(deployed);
  if (!a || !b) return { status: "unknown", loaded: a, deployed: b };
  return { status: a === b ? "match" : "differs", loaded: a, deployed: b };
}

// Fetch version.json past every cache between here and the origin.
//
// Three separate defeats, because they fail in different places: `cache: "no-store"`
// asks the HTTP cache to stand down, the timestamp query makes the URL unique so a cache
// that ignores the header has nothing to match, and the service worker skips this path
// outright (see service-worker.js) so it cannot answer from the shell cache. The whole
// point of the request is to learn what the NETWORK says; a cached answer would confirm
// staleness by being stale.
export async function fetchDeployedBuild({
  fetchImpl = typeof fetch === "function" ? fetch : null,
  url = "version.json",
  timeoutMs = 8000,
  now = () => Date.now(),
} = {}) {
  if (!fetchImpl) return null;

  // AbortController is what stops a captive portal from leaving this promise pending
  // forever. Without it a hung request holds a listener for the life of the page.
  let signal;
  let timer = null;
  try {
    const ac = new AbortController();
    signal = ac.signal;
    timer = setTimeout(() => ac.abort(), timeoutMs);
  } catch (_) { /* no AbortController: fall through without a timeout */ }

  try {
    const bust = `${url}${url.includes("?") ? "&" : "?"}t=${now()}`;
    const resp = await fetchImpl(bust, { cache: "no-store", signal });
    if (!resp || !resp.ok) return null;
    const data = await resp.json();
    if (!data || typeof data !== "object") return null;
    return {
      commit: typeof data.commit === "string" ? data.commit : null,
      fullCommit: typeof data.fullCommit === "string" ? data.fullCommit : null,
      builtAt: typeof data.builtAt === "string" ? data.builtAt : null,
    };
  } catch (_) {
    // Offline, aborted, 404 on a host that predates version.json, HTML error page where
    // JSON was expected — all the same answer: we do not know, and that is not a fault.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The whole check in one call: what this page is, what the origin serves, and the verdict.
export async function checkDeployedBuild({ config = {}, ...opts } = {}) {
  const deployed = await fetchDeployedBuild(opts);
  const result = compareBuilds(config.BUILD_ID, deployed?.commit);
  return { ...result, builtAt: config.BUILT_AT || null, deployedBuiltAt: deployed?.builtAt || null };
}

// One line a human can act on. Names both commits in the "differs" case, because the
// entire reason a developer asked for this is to know WHICH build is on the phone —
// "an update is available" would answer the wrong question.
export function describeBuildComparison(result) {
  if (!result) return "Build unknown.";
  switch (result.status) {
    case "match":
      return `Running the deployed build (${result.loaded}).`;
    case "differs":
      return `Running ${result.loaded}; the server is serving ${result.deployed}.`;
    default:
      return result.loaded
        ? `Running ${result.loaded}; could not reach the server to compare.`
        : "No build stamp — this is a local or unbuilt copy.";
  }
}
