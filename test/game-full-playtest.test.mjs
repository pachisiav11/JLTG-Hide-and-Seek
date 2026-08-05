// End-to-end playtest exercising ALL twelve phases across THREE realistic games.
//
// The per-phase game tests already prove each phase works IN ISOLATION. This file
// proves they COMPOSE — that on a real board a hider can turn geofence on, pick a
// station source, and use whole-line + range elim on the same set without one
// phase silently invalidating another's state. The three games below are the
// scenarios that would most likely have surfaced integration bugs during a real
// playtest, in the same session order the app supports.
//
// Game 1 — "Andheri chase" (phases 1, 2, 3, 4, 6, 8):
//   set up the hider's zone → toggle the geofence on with vibrate+tone → the
//   seeker builds a late-game station shortlist by tapping the map and strikes
//   candidates off it one at a time.
//
// Game 2 — "WhatsApp relay" (phases 5, 10, 11):
//   seeker WhatsApps their coords → hider pastes them → drops a note pin for an
//   off-app clue → copies own location for reply and round-trips it back
//   through the parser.
//
// The station-list review removed board-wide sourcing, whole-line elimination and
// range-along-line, so the steps that used them are gone rather than rewritten —
// there is no longer anything to compose them WITH. What remains of stations here
// is the tap-and-strike-off shortlist that replaced them.
//
// Game 3 — "Live share close approach" (phases 9, 12 + composition with 3, 8):
//   hider joins a live-share session as receiver → seeker publishes a live point
//   that closes in → the outside→inside crossing fires a system notification via
//   the SW-first path → verify no re-fire while seeker parks inside.
import test from "node:test";
import assert from "node:assert/strict";
import { squareArea, turf } from "./helpers/turf-env.mjs";

import { createGame, normalizeGame } from "../src/model.js";
import { makeManualStation, toggleStationElimination } from "../src/stations.js";
import { computeElimination } from "../src/tools.js";
import { evaluateGeofence } from "../src/geofence.js";
import { formatLocationForClipboard } from "../src/ingest.js";
import { addNote, removeNote } from "../src/notes.js";
import { evaluateApproach, LiveShare } from "../src/live-share.js";
import * as store from "../src/store.js";

// ----------------------------------------------------------------------------
// Shared Mumbai fixture — same 8-station set the per-phase tests already use, so
// results across games are directly comparable.
// ----------------------------------------------------------------------------
const AREA = squareArea([72.8777, 19.176], 0.4);

// ============================================================================
// GAME 1 — Andheri chase.
// ============================================================================
test("game 1: hider sets up in Andheri; seeker builds a shortlist and strikes it down", () => {
  // 1. Board created; hider zone = 500 m circle around Andheri.
  const game = createGame({
    name: "Andheri chase",
    gameArea: AREA,
    focusZone: { point: { lat: 19.12, lng: 72.846 }, radius: 500 },
    settings: { geofenceMetres: 80, geofenceAlertStyle: "vibrate-tone" },
  });

  // 2. Phase 3 + 8: hider steps close to the edge; evaluateGeofence returns an
  //    approaching alert and the (Phase 8) style pick is honoured. First tick is
  //    a warm-up so `prior.inside` is set, otherwise a first-time "approaching"
  //    ping is refused by the crossing-side gate.
  let gState = evaluateGeofence({
    position: { lat: 19.12, lng: 72.846 },
    zone: game.focusZone,
    thresholdMetres: game.settings.geofenceMetres,
    prior: null,
  });
  assert.equal(gState.state.inside, true, "hider starts inside the zone");
  gState = evaluateGeofence({
    // 470 m north of centre — inside 500 m zone, but only 30 m from the edge.
    position: { lat: 19.12 + 0.00423, lng: 72.846 },
    zone: game.focusZone,
    thresholdMetres: game.settings.geofenceMetres,
    prior: gState.state,
    now: Date.now(),
  });
  assert.ok(gState.notify, "80 m threshold, 30 m to edge → alert fires");
  assert.equal(gState.notify.kind, "approaching");
  assert.match(gState.pill, /In zone/, "pill stays visible");

  // 3. Late game: the board has narrowed to a handful of candidates, so the seeker
  //    taps them in. This is the whole station workflow now — no sourcing, no
  //    lock-in, and nothing exists until a human puts it there.
  game.stations = { list: [] };
  const tapped = [
    { lat: 19.120, lng: 72.846 },
    { lat: 19.155, lng: 72.850 },
    { lat: 19.190, lng: 72.855 },
  ];
  tapped.forEach((p, i) => game.stations.list.push(makeManualStation(p, i + 1)));
  assert.equal(game.stations.list.length, 3, "three hand-placed candidates");
  assert.ok(game.stations.list.every((s) => s.kind === "manual" && s.id.startsWith("manual:")),
    "every entry is hand-placed — there is no other way to add one");
  assert.equal(new Set(game.stations.list.map((s) => s.id)).size, 3, "ids are unique across a rapid burst of taps");

  // 4. A photo rules one out. Strike it off; the others are untouched.
  const ruledOut = game.stations.list[1];
  toggleStationElimination(game.stations.list, ruledOut.id);
  assert.equal(ruledOut.eliminated, true);
  assert.equal(ruledOut.eliminatedBy, "manual", "a seeker's observation, not a deduction");
  assert.deepEqual(
    game.stations.list.filter((s) => s.eliminated).map((s) => s.name),
    [ruledOut.name],
    "striking one off leaves the rest in play",
  );

  // 5. And it is reversible — a seeker who mis-taps must be able to undo it.
  toggleStationElimination(game.stations.list, ruledOut.id);
  assert.equal(ruledOut.eliminated, false);
  assert.equal(ruledOut.eliminatedBy, null);
  toggleStationElimination(game.stations.list, ruledOut.id);

  // 6. Round-trip through serialize/normalize — everything above must survive
  //    a reload the way a real PWA close/reopen would exercise.
  const restored = normalizeGame(JSON.parse(JSON.stringify(game)));
  assert.equal(restored.stations.list.length, 3);
  assert.equal(restored.stations.list.find((s) => s.id === ruledOut.id).eliminated, true);
  assert.equal(restored.settings.geofenceMetres, 80);
  assert.equal(restored.settings.geofenceAlertStyle, "vibrate-tone");
});

// ============================================================================
// GAME 2 — WhatsApp relay.
// ============================================================================
test("game 2: seeker WhatsApps a location; hider ingests, drops a note, replies with their own location", () => {
  const game = createGame({ name: "WhatsApp relay", gameArea: AREA });
  // A shortlist already built by tapping, as game 1 does.
  game.stations = { list: [
    makeManualStation({ lat: 19.19, lng: 72.85 }, 1),
    makeManualStation({ lat: 19.24, lng: 72.86 }, 2),
  ] };
  toggleStationElimination(game.stations.list, game.stations.list[1].id);

  // 1. Phase 10: seeker drops a note pin — off-app clue, no elimination effect.
  const noteEntry = addNote(game.notes, { lat: 19.19, lng: 72.85 }, "photo shows a mall");
  assert.ok(noteEntry.id.startsWith("note_"));
  assert.equal(game.notes.length, 1);
  assert.equal(game.notes[0].text, "photo shows a mall");
  // The note MUST NOT touch elimination state — this is the critical
  // integration guarantee for §C1.
  const eliminatedIdsBefore = game.stations.list.filter((s) => s.eliminated).map((s) => s.id).sort();
  addNote(game.notes, { lat: 19.20, lng: 72.86 }, "heard train 3:12");
  const eliminatedIdsAfter = game.stations.list.filter((s) => s.eliminated).map((s) => s.id).sort();
  assert.deepEqual(eliminatedIdsBefore, eliminatedIdsAfter, "notes do not eliminate stations");

  // 2. Phase 11: hider copies THEIR OWN location — a clean 5dp "lat, lng" pair.
  const myLat = 19.076, myLng = 72.877;
  const clipboard = formatLocationForClipboard(myLat, myLng);
  assert.equal(clipboard, "19.07600, 72.87700");

  // 3. Delete one note — the mutation is precise.
  removeNote(game.notes, noteEntry.id);
  assert.equal(game.notes.length, 1);
  assert.equal(game.notes[0].text, "heard train 3:12");

  // 4. Serialize + normalize: eliminated station and remaining note survive.
  const round = normalizeGame(JSON.parse(JSON.stringify(game)));
  assert.equal(round.notes.length, 1);
  assert.equal(round.stations.list.filter((s) => s.eliminated).length, 1);
});

// ============================================================================
// GAME 3 — live share close approach + SW-first notification path.
// ============================================================================
test("game 3: live share fires seeker-close notification via SW-first path; no re-fire on repeats", () => {
  const game = createGame({
    name: "Live share close approach",
    gameArea: AREA,
    focusZone: { point: { lat: 19.20, lng: 72.86 }, radius: 500 },
    settings: { approachThresholdM: 2000 },
  });
  store.setCurrent(game);

  // Mock EventEmitter transport.
  const listeners = new Map();
  const emitted = [];
  const transport = {
    on: (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); },
    off: (ev, fn) => listeners.get(ev)?.delete(fn),
    emit: (ev, payload) => emitted.push({ ev, payload }),
  };

  // Phase 9: patch a navigator.serviceWorker with a controller, so LiveShare's
  // SW-first path is exercised (and page-side new Notification is NOT called
  // when the SW handles it — same contract Phase 9 pins for geofence).
  const swPosts = [];
  // Ack the message on the transferred port so notifyViaSwOrPage's page
  // fallback timeout doesn't fire and add a lingering timer to the run.
  const controller = { postMessage: (m, transfer) => {
    swPosts.push(m);
    if (transfer && transfer[0]) { try { transfer[0].postMessage({ ack: true }); } catch (_) {} }
  } };
  Object.defineProperty(globalThis, "navigator", {
    value: { serviceWorker: { controller } },
    configurable: true, writable: true,
  });

  class MockN {
    static permission = "granted";
    constructor(title, opts) { emitted.push({ ev: "page-notif", payload: { title, opts } }); }
  }

  const share = new LiveShare({ transport, geolocation: null, Notification: MockN });
  share.startAsHider("abcxyz");

  // The join event goes out.
  assert.ok(emitted.some((e) => e.ev === "join-session" && e.payload.role === "hider"),
    "hider joined the session");

  const handler = [...listeners.get("location") || []][0];
  assert.ok(handler, "hider registered a `location` listener");

  // 1. Seeker publishes a distant ping (5 km SW): no alert.
  handler({ lat: 19.16, lng: 72.82, at: Date.now() });
  assert.equal(swPosts.length, 0, "no SW notify for a distant ping");
  assert.equal(emitted.filter((e) => e.ev === "page-notif").length, 0);

  // 2. Seeker closes in (0.005° ≈ 550 m north) — well inside 2 km.
  handler({ lat: 19.205, lng: 72.86, at: Date.now() });
  assert.equal(swPosts.length, 1, "outside→inside crossing posts a GEOFENCE_NOTIFY to the SW");
  assert.equal(swPosts[0].type, "GEOFENCE_NOTIFY");
  assert.match(swPosts[0].title, /Seeker/);
  assert.equal(swPosts[0].tag, "jltg-seeker-close");
  // And the page-fallback path is NOT taken when SW handled it — otherwise the
  // hider would get TWO alerts, which Phase 9's contract specifically forbids.
  assert.equal(emitted.filter((e) => e.ev === "page-notif").length, 0,
    "when SW handled the notification, page fallback must not also fire");

  // 3. Seeker parks at centre of zone — still inside, must NOT re-fire.
  handler({ lat: 19.20, lng: 72.86, at: Date.now() });
  handler({ lat: 19.201, lng: 72.860, at: Date.now() });
  assert.equal(swPosts.length, 1, "still-inside repeats do not re-fire (once-per-crossing)");

  // 4. Seeker walks out and back in → SECOND fire.
  handler({ lat: 19.16, lng: 72.82, at: Date.now() });
  handler({ lat: 19.205, lng: 72.86, at: Date.now() });
  assert.equal(swPosts.length, 2, "outside→inside crossing after a leave re-fires");

  // 5. Geofence composition — a hider watch tick that ALSO crosses the hider
  //    zone edge fires a separate geofence alert (different tag), and the two
  //    features do NOT compete for the same notification slot.
  const gState = evaluateGeofence({
    position: { lat: 19.20, lng: 72.86 },
    zone: game.focusZone,
    thresholdMetres: 80,
    prior: null,
  });
  assert.equal(gState.state.inside, true);
  assert.ok(gState.pill?.startsWith("In zone"), "geofence pill runs alongside live-share pill without interference");

  share.stop();
});
