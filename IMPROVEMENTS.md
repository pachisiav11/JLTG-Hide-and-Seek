# Phase 7+ Prompt — Post-Launch Improvements

> **This file is written to be pasted directly into a fresh session as a build
> prompt** (originally for Opus), continuing JLTG in the same phased workflow
> used for Phases 0–6. It is derived from hands-on testing and source review of
> two other Jet Lag: The Game Hide & Seek companions:
> **[gelbh/jetlag](https://github.com/gelbh/jetlag)** (live multiplayer PWA) and
> **[cniehaus/hideandseek-map](https://github.com/cniehaus/hideandseek-map)**
> (vanilla-JS OSM planning tool). Rationale/citations are kept inline so you
> don't need the original conversation to understand *why* each item exists.
>
> **This is a merge, not a greenfield build.** Every item below is tagged
> **[ADD]** (new code, additive) or **[REPLACE]** (modifies/supersedes existing
> behavior in a named file). Read the referenced file before touching it —
> integrate into the existing implementation, don't scaffold a parallel version.

---

## 0. Read first

Before touching any code, read, in order:
1. [README.md](README.md) — current status, run/config instructions.
2. [GUIDE.md](GUIDE.md) — vision, locked platform decisions (§2), data model
   (§4, §8), and **§9 Workflow & Repository** — the phase discipline you must
   follow here too.
3. This file, in full, before starting Phase 7.

**Hard constraint: Google Maps JS API is currently load-bearing, not optional.**
[src/maps.js:18](src/maps.js) rejects app startup outright without a valid key,
and every overlay drawn by [src/layers.js](src/layers.js) (Radar circles,
Thermometer/Matching/Tentacles polygons, pins) is a `google.maps.*` object. It
is the map *rendering engine* itself, not just a data source — nothing below
removes this dependency short of Phase 13-scale work, and even then it isn't
in scope. Treat "reduce Google Maps dependency" items as *supplementing* Places
lookups only, never as replacing `src/maps.js`.

**Hosting target: Render, not GitHub Pages.** The current deploy
(README.md "Live demo") is a static GitHub Pages site — no backend. Moving to
Render changes what's actually feasible:
- Render can host this as a **Static Site** (same as today, zero backend) if a
  phase doesn't need one, **or** as a small **Web Service** (Node/Express)
  alongside it if a phase does — e.g. a same-origin proxy for Overpass calls
  (Phase 10) or a realtime backend (Phase 13). Don't provision a Web Service
  until a phase actually needs one; default to Static Site.
- **Config/API key handling changes.** Today `config.js` is a git-ignored local
  file (GUIDE.md §3, README "Configuration"). On Render, prefer **environment
  variables** injected at build time (Render's dashboard/`render.yaml`) over a
  git-ignored file — this is the natural place to also add basic key
  protection (see Phase 8) since Render can inject secrets a static host can't.
- If a Web Service is added in a later phase, keep the Static Site (map UI) and
  Web Service (proxy/backend) as **separate Render services** talking over
  HTTPS — don't collapse the PWA into a server-rendered app.
- **Domain: use Render's default `*.onrender.com` subdomain** — no custom
  domain/DNS setup in scope. Every Google Cloud API-key referrer-restriction
  step below should whitelist that default subdomain specifically.

**Ground rules (same as GUIDE.md §9, restated):**
- Build strictly in phases. Finish one phase fully — implement, verify it runs,
  commit, push — before starting the next. Do not jump ahead or bundle phases.
- **Work through Phases 7–13 autonomously, in order, without pausing for
  confirmation between phases.** Still commit and push at the end of every
  single phase (the ritual below) — "autonomous" means don't stop and wait for
  a go-ahead, not "skip the ritual."
- End-of-phase ritual, every phase, no exceptions: verify deliverables → update
  `README.md`'s Status section (and this file, if scope shifted) → commit as
  `Phase N: <summary>` → push to the repo.
- Do not modify the locked Phase 0–6 architecture (Google Maps JS API, Turf.js,
  IndexedDB, no build step — [GUIDE.md](GUIDE.md) §2) unless a phase below says
  so explicitly. Borrow patterns from the two reference projects; do not import
  their stacks.
- If a phase's scope turns out to be bigger than expected mid-implementation,
  stop, split it, and say so — don't silently cut corners to fit the phase
  boundary.
- **Phases 10 and 13 are gated ("only start if...") by design, not by a fixed
  metric.** Treat them as part of the normal progressive sequence — reaching
  Phase 10/13 in order is itself the signal to start them, not a separate
  quota/cost threshold to independently verify first.

---

## Phase 7 — Guide-rendering & interaction polish (low risk, no new deps)

Everything here modifies existing rendering/tools code in place — good first
phase, nothing architectural, no hosting impact (Static Site only).

- **[REPLACE]** **Per-step guide differentiation.** `_renderGuides` in
  [src/layers.js:131](src/layers.js) currently draws every enabled step's
  circles/Voronoi outlines in one fixed style per guide *type*, regardless of
  which step produced them. Verified (see prior investigation) that the
  *elimination math* already handles multiple simultaneous same-tool questions
  correctly and order-independently (`computeActiveArea`,
  [src/tools.js:408](src/tools.js)) — this is purely a rendering gap. Fix: cycle
  guide stroke color per step index (or per-step hash), so two open Tentacle
  questions are visually distinguishable. Reference: cniehaus renders the
  chosen Voronoi cell filled and every other cell dashed, per question.
- **[ADD]** **Draggable Radar/Thermometer anchors.** Currently anchors are set
  by re-tapping. Add drag-to-reposition on the anchor marker (Radar centre,
  Thermometer A/B points) so correcting a mis-tapped point doesn't require
  restarting the tool. Reference: cniehaus's Radius Tool and Distance &
  Direction tool both support dragging an already-placed marker.
- **[ADD]** **Colour-blind safe palette.** Add a toggle (persisted in
  `localStorage`) between the current palette and an Okabe-Ito/Paul-Tol-based
  alternative, applied to all active shaded layers and guides instantly, no
  re-fetch. Given the entire elimination model communicates state through fill
  colour, this is high accessibility value for low effort. Reference:
  cniehaus's colour-mode toggle in `js/config.js` (`COLOR_THEMES`).
- **[ADD]** **Suggested game-area size tier.** When framing/assembling a game
  area (Phase 1's `turf.union` step), compute the resulting area and surface a
  sanity-check hint (e.g. "~450 sq mi — Medium") before the user commits, the
  same way gelbh's "frame the game area" step does. Small, contained addition
  to the existing zone-assembly UI.

**Commit + push.**

---

## Phase 8 — Data resilience, validation & Render config migration

Hardens the existing local-only architecture and moves config to Render's
env-var model. No new user-facing features.

- **[ADD]** **Validate on read, not just on import.** `validateGame` in
  [src/model.js:64](src/model.js) is currently only exercised on JSON import.
  Run the same (or a stricter) shape check whenever a game is loaded from
  IndexedDB, so a corrupted/partially-written record surfaces a clear error
  instead of throwing deep inside the renderer.
- **[ADD]** **Contain renderer failures.** Wrap `render()`
  ([src/layers.js:98](src/layers.js)) and `computeElimination`/
  `computeActiveArea` calls in a try/catch that shows a recoverable error
  banner ("this step failed to render, try disabling it") instead of leaving
  the map blank or throwing uncaught. A single malformed Turf.js geometry
  currently has no documented failure path.
- **[REPLACE]** **Move config to Render environment variables.**
  [config.example.js](config.example.js) / git-ignored `config.js` currently
  hold `GOOGLE_MAPS_API_KEY` as a plain client-side value (README
  "Configuration" already flags this is visible in-browser). On Render,
  inject the key via the dashboard/`render.yaml` at build time instead, and
  have `config.js` read it from the injected value rather than a checked-out
  local file. This doesn't hide the key from the browser (it's a client-side
  Maps JS key either way — still must stay HTTP-referrer-restricted in Google
  Cloud, GUIDE.md §3) but removes the manual "copy config.example.js" step
  from every deploy and keeps local dev (`config.js`, git-ignored) unchanged.
  **When this item is done, stop and walk the user through it step by step**
  — don't just say "configured": give the actual Render dashboard steps to (1)
  create the Static Site and point it at the repo, (2) add `GOOGLE_MAPS_API_KEY`
  as an environment variable in Render's dashboard (or `render.yaml` if one is
  added), (3) confirm the build step reads it into `config.js` correctly, and
  (4) update the Google Cloud API key's HTTP referrer restriction to include
  the app's default `*.onrender.com` subdomain (no custom domain is in scope)
  — otherwise Maps requests will be silently rejected in production even
  though local dev still works.
- **[ADD]** **Confirm boundary precision on place search.** Verify the
  Places/Geocoding lookup used when importing a game area by name returns the
  precise administrative boundary (not an approximate viewport box) — same
  standard cniehaus achieves via the exact OSM relation ID from Nominatim. If
  Google's Geocoding API already returns precise boundary data for the
  searched place, document that in GUIDE.md §4; if it's currently falling back
  to a bounding box, that's the gap to close here.

**Commit + push.**

---

## Phase 9 — Admin-division tool + reusable custom categories

Extends the existing Matching tool family; builds on the Voronoi engine
already shared by Matching/Tentacles (GUIDE.md §5.3/§5.5). No hosting impact.

- **[ADD]** **Admin-division comparison.** New Matching variant: tap two
  points, reverse-geocode both, and compare across levels (neighbourhood →
  city → county → state), marking each ✓/✗/–. Reference: cniehaus's
  admin-division checker (4 levels, per-level field lists) and gelbh's
  `adminDivisionGeometry.ts` / `classifyAdminDivisionAtPoint` (clips admin
  boundaries to the game area for elimination — the same building block,
  framed as an elimination region rather than a two-point comparison).
- **[ADD]** **Custom, reusable categories and pins.** Let a saved game (or the
  zone library) define custom Places categories and named location pins
  beyond the built-in list, reusable across games the same way the zone
  library already is (GUIDE.md §4). Reference: gelbh's `SessionCustomCategory`
  / `SessionCustomLocationPin`. This is the long-term fix for regional data
  gaps too (see Phase 10) — a group that plays repeatedly in one city can
  patch missing categories once.

**Commit + push.**

---

## Phase 10 — Optional Overpass fallback for Places search (Render Web Service)

Reached in the normal progressive phase order — that's the trigger to start
it, not a separately-verified quota/cost metric (see §0). It's a mitigation
against Places API cost/quota risk, not a required migration — do **not**
replace the Google Maps engine; see "Explicitly not recommended" below.

**Hosting note:** this is the first phase that benefits from Render's Web
Service tier. Route Overpass calls through a small same-origin proxy endpoint
on Render (Node/Express is enough) rather than calling public Overpass
instances directly from the client — this sidesteps CORS friction, lets you
centralize the multi-endpoint retry/backoff logic server-side, and keeps a
consistent origin for rate-limit purposes. The Static Site (map UI) stays as
is; add the proxy as a second Render service.

- **[ADD]** **Overpass as a fallback, not a default.** When a Places category
  search fails or is quota-exhausted, fall back to a query through the new
  Render-hosted proxy. Maintain a multi-endpoint fallback list server-side
  (cniehaus and gelbh both maintain 2–3 public Overpass endpoints and retry
  across them) since any single public instance can be rate-limited or down.
- **[ADD]** **Regional density fallback ladder**, for when OSM data itself is
  thin (varies heavily by region — Western Europe is well-mapped, other
  regions much less so):
  1. Broaden the Overpass query's tag matching before assuming data is
     missing (e.g. `amenity=hospital` OR `healthcare=hospital` OR
     `building=hospital`).
  2. Count results before offering the category as a question option; if thin
     (under ~3–5), don't silently offer a degenerate question.
  3. If still thin, fall back *to* Google Places for that specific
     category/area (using the existing API key) — a backstop, not a default.
  4. Point users at Phase 9's custom-category feature as the long-term local
     fix for a specific city's gaps.
- This is a **per-category, per-area** decision, not a global source switch.

**Commit + push.**

---

## Phase 11 — Question timers + optional "computed truth" check

No hosting impact — client-side only.

- **[ADD]** **Soft per-question timer.** Add an optional countdown once a
  question is asked (configurable in Settings, default off, since JLTG is
  currently single-device/planning-oriented rather than live-timed).
  Reference: gelbh blocks new questions until the current one resolves and
  shows a countdown.
- **[ADD]** **Optional computed-truth verification.** JLTG deliberately
  removed auto-answer (README.md Phase 5 note) in favor of fully manual
  answers — do **not** revert that. Instead, add an opt-in check: after the
  hider manually answers, compute the geometrically correct answer (using the
  same Turf.js primitives already in [src/tools.js](src/tools.js), plus an
  elevation lookup only if/when Measuring's sea-level mode needs it) and flag
  a disagreement ("your answer disagrees with computed geometry — double
  check") without ever overriding the manual answer. Reference: gelbh's
  `HiderTruthResult`, including its "truth unavailable, compute manually"
  fallback for cases geometry can't resolve.

**Commit + push.**

---

## Phase 12 — Presentation polish

No hosting impact — client-side only.

- **[ADD]** **Multiple map styles.** Add at least a satellite toggle and a
  dark style alongside the current base style, plus a print-ready export view
  of the current `activeArea` (browser print-to-PDF is sufficient, no new
  dependency). Reference: cniehaus's 6 tile styles + A4 print export.
- **[ADD]** **i18n scaffolding.** If non-English support is ever needed, use
  cniehaus's no-dependency pattern: plain JS translation objects
  (`langs/xx.js`) plus a `t()`/`tf()` helper — skip unless there's an actual
  second-language need.
- **[ADD]** **PWA update UX.** The service worker already handles the offline
  shell (GUIDE.md §6.3/§7). Add a visible "update available, reload" banner
  instead of a silent background swap, so players don't unknowingly run a
  stale cached version mid-game. Reference: gelbh's update banner + in-app
  changelog sheet tied to releases.

**Commit + push.**

---

## Phase 13 — Live multiplayer sync (major, separate design pass — do not start casually)

This is the single largest capability gap versus gelbh (session code, live
sync across seeker/hider devices via Firebase) and a genuine scope-defining
architectural decision, not an incremental patch. Reached in the normal
progressive phase order (see §0) — that's the signal to start the design pass
below, not a separately-verified trigger. **Still do not jump straight to
implementation** — do the design doc first:

1. Write a short design doc (new file, e.g. `MULTIPLAYER_DESIGN.md`) covering:
   session/role model (`hider` vs `seeker`) layered on the existing `Game`
   data model ([src/model.js](src/model.js)), and conflict handling for
   concurrent zone/step edits.
2. **Backend/hosting: Render-owned Node + Socket.IO Web Service, following the
   same pattern as `CIRCUIT`** (a prior project of the developer's — a single
   Express + Socket.IO server, deployed via `render.yaml` as a free-tier
   Render Web Service, no external realtime vendor or API key required for
   the multiplayer relay itself). Concretely:
   - `server.js`: Express serves as the relay; Socket.IO rooms keyed by a
     session code (mirrors Circuit's structure, adapted from game moves to
     JLTG's `Step`/annotation events).
   - `render.yaml`: `type: web`, `runtime: node`, `plan: free`,
     `buildCommand: npm install`, `startCommand: npm start` — same shape as
     Circuit's blueprint.
   - This pairs naturally with the Phase 10 Overpass proxy: both are Node Web
     Services on Render, and can be the same service (one Express app serving
     both a `/overpass` proxy route and a Socket.IO relay) rather than two,
     unless load/isolation reasons argue for splitting them.
3. Reference gelbh's `offlineQueue` pattern (IndexedDB-backed write queue,
   retry with backoff, capped failure count,
   [src/services/session/offlineQueue.ts](https://github.com/gelbh/jetlag))
   as prior art for staying offline-resilient client-side while Socket.IO
   handles the live relay — Circuit's server is a relay, not a data store, so
   JLTG's existing IndexedDB persistence stays the source of truth per device.
4. Get this design doc reviewed/confirmed before writing implementation code —
   this phase changes the "no server, no account" premise in GUIDE.md §2 and
   should be an explicit, discussed decision, not an assumed one, even though
   the backend choice itself is now settled (above).

**[ADD]** everything in this phase — there is no existing multiplayer code to
replace.

**Commit + push.**

---

## Phase 14 — Rebuild the Android APK (after all other phases are complete)

Only start this once Phases 7–13 are all done and the app is live on Render.
The existing [download/JLTG.apk](download/JLTG.apk) is a **thin TWA-style
wrapper** around the hosted PWA (~1.1 MB, per
[install_guide.html](install_guide.html)) — it just launches the live web app
in an installed shell, so it needs to be rebuilt pointing at the new Render
URL, not re-authored from scratch.

- **[REPLACE]** Rebuild the APK the same way the current one was produced
  (Bubblewrap/PWABuilder-style TWA, or whatever tool produced the existing
  ~1.1 MB wrapper — check for a build config before assuming a tool), pointed
  at the new `*.onrender.com` URL instead of the old GitHub Pages URL.
  - Same manifest/icon/theme-color as today ([manifest.webmanifest](manifest.webmanifest)) —
    this is a re-point, not a redesign.
  - Keep it a **thin wrapper**, same as now: it should still just load the
    live Render-hosted app and rely on the service worker for offline shell,
    not bundle app code into the APK.
- **[REPLACE]** Update [install_guide.html](install_guide.html): the
  `#apk-link` href, the `#apk-meta` version pill (bump from `v1.0.0`), and the
  "Download the Android app" flow text if the install steps changed at all.
- **[REPLACE]** Replace [download/JLTG.apk](download/JLTG.apk) with the newly
  built file (same filename, so the existing link keeps working).
- Sanity check after rebuilding: install it on a device and confirm it opens
  the Render-hosted app (not a cached/stale GitHub Pages version) and that the
  Google Maps API key prompt/flow still works end-to-end.

**Commit + push.**

---

## Explicitly not recommended (do not do these, in any phase)

- **Do not rewrite the stack** to React/Firebase or to a vanilla-JS/no-build
  clone of either reference project. JLTG's stack (GUIDE.md §2) is a
  deliberate, already-shipped decision. Borrow patterns, not stacks.
- **Do not drop manual-answer-only in favor of full auto-answer.** GUIDE.md's
  history shows auto-answer was tried and removed on purpose. Phase 11 above
  is an optional *check*, never a reversion to forced auto-answer.
- **Do not migrate off Google Maps for the map/transit engine, and do not
  treat it as removable.** It's currently load-bearing (see §0's hard
  constraint) — transit timing accuracy is also a documented, deliberate
  reason for the choice (GUIDE.md §2, §12). Overpass/OSM (Phase 10) is a
  fallback for Places-category search only, proxied through Render, never a
  replacement for `src/maps.js`.
- **Do not provision a Render Web Service before a phase needs one.** Default
  to Static Site; only Phases 10 and 13 currently justify a backend.
