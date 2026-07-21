# Playtest Ideas — running list

Ideas from real-world playtests, kept in one place so patterns across sessions
stay visible. Each item is stated as a change, with the *pain it removes* and a
rough size estimate. Nothing here is committed to build order — this is the
discussion pile.

Source playtests:
- [PLAYTEST_2026-07-19.md](PLAYTEST_2026-07-19.md) — small game, Mumbai Metro, 45-min hide

**Non-goals recorded from the discussion of playtest 1:**
- No online multiplayer / relay session. Session setup is too much friction for
  the actual game format, and live sync makes the game "too digitised." The
  Phase 13 relay code stays in the repo but ideas below must work **without a
  joined session** — single-device or asymmetric-device use only.

---

## 0. The reframing — role split, "current location" as a first-class anchor

Playtest 1 made clear that the two devices in a game already play different
games — the seeker asks and measures, the hider hides and answers — but the
app treats them identically. Two consequences follow:

- **The app should have a role choice** (seeker / hider) that unlocks
  side-specific features without connecting the two devices to each other.
  Same app, same install, different mode. **No relay is added.** The two
  copies of the app remain fully disconnected; anything that needs to cross
  between them still crosses through WhatsApp (or similar), just with
  smoother intake on the receiving side.
- **"Current location" becomes a first-class anchor** — a named point that
  every tool (radar, thermometer, matching) can measure from, without
  requiring the player to drop a pin. Concretely:
  - On the **seeker's device**: read from the device's own GPS. Any tool
    can be pointed at "my current location" as its anchor, one tap.
  - On the **hider's device**: populated by whatever the seeker most
    recently shared via WhatsApp — a pasted Google Maps link, a shared
    live-location intent, a copied `lat, lng`. See A2.
  - The hider-side value is a **snapshot**, not a stream. It only updates
    when the hider takes an ingest action. This is the design constraint
    that keeps us out of multiplayer territory: the app never phones home,
    and stale-location is a normal state the UI has to represent
    (timestamp on the pin, "shared 4 min ago" etc.).

Everything in A1–A2 is really this reframing landing on the two sides.

---

## A. Bring what happens outside the app *into* the app

The pattern from playtest 1: the tools are great at expressing *a fresh
geometric constraint*, but the app has no intake for *what has already been
ruled out* (by ambient knowledge, WhatsApp chatter, a POI eyeballed on Google
Maps). Everything below is one variant of that same fix.

### A1. Hider-side: geofence notification when nearing the zone edge *(medium)*

- **Pain:** During hiding time nobody actually checks whether they're still
  in the hiding zone, because it means switching to Google Maps and
  eyeballing distance to a centre point. A "tap to check" button (the
  earlier version of this idea) helps but only when the hider remembers to
  tap it; drifting toward the edge without realising is exactly the
  scenario a button doesn't catch.
- **Change:** Proactive geofence. When the hider is in hiding-mode, the app
  watches `navigator.geolocation.watchPosition` and, if the hider comes
  within **N metres of the nearest zone edge** (N is user-configurable in
  settings, default e.g. 100 m), fires a **phone notification**.
  Notification content: "You're 80 m from the zone edge — turn back."
  Tapping the notification opens the app on a map view showing their
  position, the nearest edge, and the direction to safety.
- **Implementation notes:**
  - PWA notifications require the Notifications API + a service worker
    (already have one, for offline). Permission prompt on first use of
    hiding-mode.
  - Background geolocation on the web is limited — the tab may need to
    stay foregrounded on iOS, and Android varies by browser. This should
    be scoped down honestly: probably works as "notification while the app
    is open and screen is on," and we document that instead of promising
    true background tracking. If we want true background, that's an
    installed-PWA / TWA feature and needs its own investigation.
  - The setting is a distance, not an on/off — 0 m disables it.
  - The check itself is cheap: distance-to-polygon on each GPS tick,
    against the currently-active zone geometry the app already knows.
- **Nice-to-haves:**
  - Debounce so a hider oscillating right at the boundary doesn't get
    spammed — one notification per crossing.
  - Rate-limit to at most one every K seconds.
  - A quieter foreground pill ("you are 240 m from the edge") that
    updates continuously while the app is in front, separate from the
    notification.

### A2. Ingest seeker location from WhatsApp *(medium — has design branches)*

- **Pain:** In the playtest, seekers shared their live location + radar
  centres + thermometer endpoints via **WhatsApp's "Current Location" /
  "Live Location" attachment**, not as Google Maps URL messages. That
  means "paste a Google Maps link" (the earlier version of this idea)
  doesn't reach them — a WhatsApp location share is a native attachment,
  not a URL in the chat, and doesn't sit on the clipboard as `lat, lng`.
- **Change:** Multiple intake paths, from cheapest to fanciest. Ship the
  cheap ones first; the fancier ones are worth it only if the cheap ones
  are still too rough.
  1. **Manual paste of `lat, lng`.** Bottom of the barrel but zero cost.
     Every ingest field accepts `19.15, 72.85` (or the equivalent) and
     drops the anchor. Useful when the seeker has typed coordinates or
     when a WhatsApp location can be long-pressed → "share" → paste as
     text elsewhere.
  2. **Paste a Google Maps URL.** For the case where the seeker opened
     the WhatsApp location, tapped "View on map," and copied the URL
     from Google Maps. 3-tap flow on the seeker side, one paste on the
     hider side. This is the *original* A2, kept but demoted from
     primary.
  3. **PWA share-target registration.** The main event. When installed
     as a PWA, JLTG registers itself as a **share target** for URLs /
     text / geo intents. WhatsApp's location attachment can then be
     shared *out* via the OS share sheet, and JLTG appears as an
     option; picking it opens the app with the coordinates already
     parsed. This is one action on the hider side and requires zero new
     habit on the seeker side.
     - Works on Android well; iOS PWA share-target support is thin and
       may need documenting.
     - Requires the app to be installed as a PWA, not just visited in
       a browser tab.
  4. **Live-location ingestion — explicitly out.** WhatsApp's *Live*
     Location is a continuously-updating stream and there is no
     official web hook into it. Trying to pipe it in would either
     require scraping (fragile, ToS trouble) or a bot in the chat
     (needs the very server infra we're avoiding). Not pursued.
- Once a location is ingested, it becomes the "current seeker location"
  anchor described in §0. Timestamped, replaceable, one active at a time.
- **UI note:** the ingest field should live prominently (not buried
  inside a specific tool), because in play it's the *entry point* for
  many questions in a row — "seeker is here now, so: radar 5 km from
  seeker, thermometer between seeker and Bandra, ..." Each of those tools
  should default its anchor to the current seeker location.

### A3. Manual station elimination *(medium — prerequisite work)*

- **Pain:** Off-app deductions (the photo clue, the ambient "they can't
  have got past Dahisar," the "we listed candidates by name length in our
  heads") never become map state, so the visible active area is
  systematically wider than the seekers' actual belief.
- **Change:** Tap a station on the map → "eliminate" (with an optional
  free-text note like "photo shows a building not near here"). Adds a
  manual step to the fold that removes exactly that station. Undo/redo
  like any other step.
- **Prerequisite (raised in discussion, worth calling out):** a "station"
  has to be a concrete, tappable, identifiable thing before this can work
  — not just a visual placeholder on the map. Practically this means:
  - The stations for the chosen lines are **sourced and locked in at
    game-start**, into an explicit collection with ids, positions, and
    names. The rail-sourcing already produces something like this per
    line; A3 formalises it into a game-owned station set that every
    downstream step and every UI tap refers to.
  - Game creation grows a step: "confirm the station list." This is also
    a natural place to *pre-eliminate* stations that everyone already
    knows are out of scope (see A5, and the "past Dahisar" case from
    playtest Q0).
  - Once the game has a locked station set, A3, A4, A5, and B1's "would
    eliminate X of Y stations" counter all key off the same collection.

### A4. Whole-line elimination as a first-class action *(small)*

- **Pain:** Playtest Q1 — "not the blue line" is the single most common
  yes/no in this format, and there's no button for it. The rail filter
  exists but only *hides* lines from view; it doesn't eliminate their
  stations from the active area.
- **Change:** On the existing rail-filter UI, promote "eliminate all
  stations on this line" from a hidden-view toggle to a real elimination
  step. Distinct affordance from "hide from map" (which stays view-only).

### A5. Station-range elimination on a line *(medium)*

- **Pain:** Playtest Q0 — "not past Dahisar on the yellow line." Currently
  requires eliminating stations one by one (which A3 would at least make
  possible; today it isn't possible at all).
- **Change:** On a line's station list, multi-select a contiguous or
  arbitrary range and eliminate them in one step. Depends on A3's locked
  station set.

### A6. POI-category measurement *(large)*

- **Pain:** Playtest Q6 (parks) and Q9 (theatres). "Measure from any X"
  is the archetype and needs an Overpass query for the category near a
  point.
- **Change:** Category picker (park / theatre / mall / temple / school /
  ...) → Overpass fetch → set of anchor candidates → measure from any /
  all / nearest. Result is a fold step that keeps only stations that
  satisfy the distance predicate against the fetched anchor set.
- Higher effort than A1–A5 both in code and in UX (category taxonomy,
  handling giant result sets like "any building"). Do after A3 lands so
  the "we can also just eliminate by hand" fallback is there for
  categories the app doesn't cover.

---

## B. Guided sizing for radars and thermometers

### B1. Draft-mode preview with live readout *(medium, highest per-play impact)*

- **Pain:** Before committing a radius or a thermometer endpoint, players
  have no way to know if the size they're about to pick is useful. You
  place it, guess, commit, and only then see what got eliminated. Result:
  some questions get skipped because "we're not sure what size would work."
- **Change:** Placing a radar or thermometer enters a **draft mode** —
  geometry is visible on the map but not yet a committed step. Player can:
  - drag the centre freely
  - drag a handle on the edge to resize (radar radius, thermometer far
    point)
  - see live **size number** (radius in km / thermometer distance)
  - see live **candidate impact** — "would eliminate X of Y active
    stations" for whichever answer (in/out, hotter/colder) they've
    selected
- **Commit** promotes the draft into the fold; **cancel** discards.
  Answer selection can be part of the draft ("if we say colder, this
  eliminates 40; if hotter, 12") so the size choice and the answer
  choice inform each other before either is locked in.
- Post-commit dragging already works (verified in cycle 4 game 8); this
  ports that same interaction earlier in the flow with a preview
  counter attached.
- Uses the same station set A3 introduces for the "of Y" denominator
  and the eliminate-count numerator.

**Why this is the highest-leverage single item:** the playtest lost two
questions to sizing uncertainty (implicitly — the seekers went with
10 km and 5 km radars, one a miss and one a hit, without a way to
compare "what if we'd used 7 km?"). Turning size selection from
guesswork into a visible-impact decision changes which questions get
asked, not just how they get answered.

---

## Cross-cutting: locked station set (implicit in A3, A4, A5, B1)

Several items above assume a game has an explicit, locked-at-start set of
stations with stable ids. It's worth naming this once rather than
re-describing it inside every item:

- At game creation, after lines are chosen, the app materialises the
  station list from the rail sources and asks the user to confirm it
  (rename, deduplicate, remove obvious out-of-scope entries).
- After confirmation, that list is the authoritative station domain for
  the game — every elimination step refers to station ids from this
  set, every "N of Y" count is over this set.
- This also gives a clean home for pre-game "manual pre-eliminations"
  (the "past Dahisar" case from playtest Q0), which is arguably a
  seventh first-class action but is really just A3 applied at
  game-start.

---

## C. Live-play speed and awareness — added 2026-07-20, post-Phase-1-3

Additions surfaced after the first three phases landed. All confirmed with the
user via yes/no; the last one is a **partial revision of the "no multiplayer"
non-goal** and is called out as such.

### C1. Long-press map → note pin *(small)*

- **Pain:** Off-app clues (playtest 1 Q4 "photo of a building"; ambient
  observations like "heard a train at 3:12" or "saw a bus on Route 25") don't
  end up in the app's map state. They live in someone's head or a WhatsApp
  message and are lost between sessions.
- **Change:** Long-press anywhere on the map → drop a small pin with a short
  free-text note (default label is a timestamp). Pins persist per game,
  render on the map with the note as a tooltip / on-tap popover, and can be
  removed individually.
- **Implementation notes:**
  - New per-game field `game.notes = [{id, point, text, at}]`.
  - Long-press = `mousedown/touchstart` + timer + no-move guard, same shape as
    every other pin-drop tool in the codebase.
  - Not a fold step (doesn't eliminate anything), just a visible marker — so
    it can be added and removed freely without touching the elimination engine.
- **Nice-to-haves (deferred):** photo attachment, colour-code by category.
- **Manual verification (finding #13, 2026-07-21):** Google Maps synthesises
  its own pointer events for touch, and the exact shape it delivers on iOS
  Safari vs Chrome-on-Android is NOT covered by any headless test in the suite —
  every `game-` test here drives the plain DOM listeners, never the maps
  synthesiser. Before relying on note pins during a game, verify on a real
  device:
  1. Open the game in the deployed app (GitHub Pages URL) on iOS Safari.
     Hold on the map for ~500 ms without moving your finger. A `!`-labelled
     pin should drop where you held.
  2. Same test on Chrome for Android.
  3. On both, confirm short taps do NOT drop a pin — the long-press timer
     must be the only path.
  4. If either platform misses the long-press cleanly, the fix lives in
     `src/notes.js:66` where the `mousedown`+`mouseup`+`dragstart` wiring
     is; add a `touchstart`+`touchend` pair or switch to Pointer Events.
  A manual pass on this flow has to be part of "does this build ship?"
  until a device-emulator test covers the maps synthesiser.

### C2. Copy-my-location button *(small)*

- **Pain:** Seekers already paste their location into WhatsApp so the hiders'
  device can be pointed at it (see A2). The reverse — a seeker holding their
  own phone, needing to type "19.15, 72.85" into WhatsApp themselves — is the
  same friction one direction earlier. A one-tap button is symmetric with A2's
  intake.
- **Change:** ☰ menu (or a small toolbar button) → "📋 Copy my location". Uses
  `navigator.geolocation.getCurrentPosition` + `navigator.clipboard.writeText`,
  writes `lat, lng` in the same format A2 accepts. Toast confirms.
- **Implementation notes:** trivial. Guard for the geolocation-denied case with
  the same "Location unavailable — allow location access" toast focus.js
  already uses.

### C3. Vibrate + tone on geofence alerts *(small)*

- **Pain:** Phase 3's text alert is easy to miss with the phone in a pocket
  during a hide — the hider only sees the notification when they take the
  phone out, which is exactly the "check on demand" pattern A1 exists to
  replace.
- **Change:** On any geofence alert (crossed-out / near-edge / still-out /
  back-in), also fire `navigator.vibrate([200, 100, 200])` and play a short
  tone via `AudioContext` (no audio asset — a generated beep, so the SW
  precache doesn't grow). Toggle in Settings alongside the metres threshold
  ("Off / silent / vibrate / vibrate + tone").
- **Implementation notes:**
  - Vibration API is Android-only in practice (iOS refuses); document that.
  - Tone via `OscillatorNode` — no asset, no external dependency. Two 200 ms
    beeps at 880 Hz is enough to be audible without being alarming.

### C4. Upgrade Phase 3's alerts to system notifications *(medium)*

- **Pain:** Phase 3 uses `new Notification(...)` from the page context. That
  works ONLY while the tab is foregrounded on Android; backgrounded, it does
  nothing and the whole feature silently degrades to just the on-screen pill.
  A hider whose phone is asleep in a pocket sees no alert at all — the exact
  failure mode A1 was written to close.
- **Change:** Route notifications through the service worker's
  `registration.showNotification(...)` instead. That is what Android treats as
  a first-class system notification: it goes to the notification tray, wakes
  the phone, honours the user's notification-priority settings, and survives a
  backgrounded tab.
- **Implementation notes:**
  - `postMessage` from the page to the SW with the notification payload; the
    SW calls `showNotification()`. (Keeps the decision logic in
    `evaluateGeofence()` — the SW is only the display arm.)
  - Requires the SW to be in scope and registered (already true; Phase 12
    infra).
  - Needs a `notificationclick` handler in the SW that focuses the existing
    tab / opens a new one if none is open.
  - Icon: existing `icons/icon-192.png`.
- **What this does NOT fix:** true background GPS. Even with SW notifications
  the geofence check itself needs a live position, and mobile browsers
  throttle backgrounded geolocation. This upgrade covers "phone asleep, tab
  still ticking" but not "tab evicted an hour ago". True background is still
  a TWA/native concern.

### C5. Live seeker-location share → auto-alert when close to hiding zone *(large — revises a non-goal)*

- **Non-goal revision (2026-07-20):** the "No online multiplayer / relay
  session" line at the top of this doc is **partially rolled back**. This item
  adds a narrow one-way channel: **seeker → hider**, streaming only
  coordinates, not game state. Full state sync (Phase 13 style) stays out of
  scope; anything else that crosses between devices still goes through
  WhatsApp. The reason for the reversal is that the seeker-position pain
  playtest 1 recorded (systemic pain 2) survives even after A2's manual
  paste is built: paste-driven ingest is a snapshot, and this is meant to be
  a live, autonomous check the hider does not have to remember to run.
- **Pain:** During a hide, the hider has no automatic notion of where the
  seekers are. WhatsApp share is manual and lossy. Even with A2 landed, a
  hider who has not pasted in the last 5 minutes has no idea if the seekers
  are closing in.
- **Change:** Two new panels, one channel.
  - **On the seeker's device:** a "Share my live location" toggle. When on,
    the seeker's phone publishes its GPS to a relay every ~60 s, tagged with
    a session code.
  - **On the hider's device:** a "Receive seeker location" panel. Enter the
    same session code, subscribe. The seeker's last-known point is visible
    on the map (as an S pin, timestamped), and every ~60 s (i.e. on every
    update) the hider's device compares that point to the hiding zone centre
    and fires a **system notification** (see C4) when the distance drops
    below a user-configurable threshold (default: 2 km). One notification
    per crossing.
- **Implementation notes:**
  - Requires the Socket.IO relay to come back, on the same backend service
    the Overpass proxy is deployed to. The Phase 13 code was deleted (commit
    `3f2ce4b`) but MULTIPLAYER_DESIGN.md still documents the shape. The
    reduced scope here (one topic, one direction, no game state) is much
    smaller than Phase 13's full CRDT.
  - Only publishes lat/lng + a timestamp. No game state, no history, no
    presence beyond "seen a ping in the last minute".
  - Session code entry mirrors the removed Phase 13 flow: 6-char code,
    generated on the seeker's device, typed into the hider's device.
  - Alert threshold configurable in Settings (default 2 km, "0" disables the
    alert but keeps the pin visible).
  - The seeker's device can also show its own "you are being shared" pill,
    so a seeker cannot forget the toggle is on.
- **What this does NOT do:**
  - No hider → seeker channel (per the non-goal reason — that would defeat
    the game).
  - No stale-data handling per user 2026-07-20: the live channel is trusted
    as fresh. If the seeker's phone loses signal, the pin goes stale
    silently; a follow-up phase could add a "no ping in N minutes" warning
    if this bites in real play.
  - No game-state sync of any kind. Elimination, zones, questions, station
    lists all stay per-device.

---

## Rough order to think about

Not a build order — just how these stack up if we had to pick one at a time.
Numbers in parentheses are cross-references, not dependencies unless
explicitly noted.

1. **Locked station set** — *DONE 2026-07-20* ([de56074](https://github.com/pachisiav11/JLTG-Hide-and-Seek/commit/de56074)).
2. **B1** — draft-mode preview. *DONE 2026-07-20* ([78152cc](https://github.com/pachisiav11/JLTG-Hide-and-Seek/commit/78152cc)).
3. **A1** — hider geofence notification. *DONE 2026-07-20* ([4c77464](https://github.com/pachisiav11/JLTG-Hide-and-Seek/commit/4c77464)).
4. **A4** — whole-line elimination. Playtest Q1 alone justifies it;
   small once A3's station set is in place.
5. **A2** — WhatsApp location ingest. Start with `lat, lng` paste and
   Google Maps URL paste; consider PWA share-target after that if
   friction is still felt.
6. **A3** — manual station elimination as a real user action.
7. **A5** — range elimination on a line.

Then the §C additions (added post-Phase-3):

8. **C3** — vibrate + tone on geofence alerts. Small, immediately makes
   Phase 3 useful with the phone in a pocket.
9. **C4** — upgrade geofence alerts to system notifications via the SW.
   Closes the "backgrounded tab does nothing" gap in Phase 3.
10. **C1** — long-press map → note pin. Small, self-contained,
    playtest-clue capture.
11. **C2** — copy-my-location button. Trivial; symmetric with A2.
12. **C5** — live seeker-location share to hider. Largest of the §C set;
    revives a narrow slice of multiplayer for a real playtest pain.

13. **A6** — POI-category measurement. Deferred; do after A3 lands the
    manual fallback for uncovered categories.

---

## Things NOT to change (recorded so they don't get re-discussed)

- The three tools that *were* used cleanly in playtest 1 — thermometer,
  radar, endgame — need no interaction changes beyond B1's preview
  layer.
- The Google Maps rendering engine and the elimination math stay as-is;
  everything above is UI/intake, not compute.
- Multiplayer / relay session flow — the non-goal at the top is
  **partially rolled back 2026-07-20** by §C5 (one-way seeker→hider
  location, no game state). Any BROADER multiplayer — game state sync,
  hider→seeker channel, presence beyond a location ping — remains out
  of scope. Two-way sync stays a no.
- WhatsApp Live Location ingest — infeasible without server infra we've
  ruled out (see A2.4).
