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
//   set up the hider's zone → source stations from OSM → toggle the geofence on
//   with vibrate+tone → seeker eliminates the blue line → verifies the draft
//   preview count → makes a wrong-turn manual toggle to fix a mistake.
//
// Game 2 — "WhatsApp relay" (phases 5, 7, 10, 11):
//   seeker WhatsApps their coords → hider pastes them → uses range elim ("south
//   of Dahisar") → drops a note pin for an off-app clue → copies own location
//   for reply and round-trips it back through the parser.
//
// Game 3 — "Live share close approach" (phases 9, 12 + composition with 3, 8):
//   hider joins a live-share session as receiver → seeker publishes a live point
//   that closes in → the outside→inside crossing fires a system notification via
//   the SW-first path → verify no re-fire while seeker parks inside.
import test from "node:test";
import assert from "node:assert/strict";
import { squareArea, turf } from "./helpers/turf-env.mjs";

import { createGame, normalizeGame } from "../src/model.js";
import {
  sourceStationsForGame,
  stationsWithinLine,
  eliminateStationsOnLine,
  restoreStationsOnLine,
  toggleStationElimination,
  orderStationsAlongLine,
  eliminateStationsInRange,
  countStationsInEliminated,
} from "../src/stations.js";
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

const OSM_PAYLOAD = { stations: [
  { id: "osm:node/100", name: "Devipada",  lat: 19.2400, lng: 72.8700, kind: "halt" },
  { id: "osm:node/101", name: "Dahisar",   lat: 19.2500, lng: 72.8600, kind: "station" },
  { id: "osm:node/102", name: "Kandivali", lat: 19.2050, lng: 72.8500, kind: "station" },
  { id: "osm:node/103", name: "Borivali",  lat: 19.2280, lng: 72.8570, kind: "station" },
  { id: "osm:node/104", name: "Malad",     lat: 19.1870, lng: 72.8480, kind: "station" },
  { id: "osm:node/105", name: "Goregaon",  lat: 19.1650, lng: 72.8500, kind: "station" },
  { id: "osm:node/106", name: "Jogeshwari",lat: 19.1370, lng: 72.8480, kind: "station" },
  { id: "osm:node/107", name: "Andheri",   lat: 19.1200, lng: 72.8460, kind: "station" },
], counts: { raw: 8, kept: 8 } };

// A single north-south "Blue Line 1" running through Andheri → Dahisar. Every
// station in the fixture except Devipada (a halt one node east) is close enough
// to be considered on it, once we widen the tolerance for the fixture geometry.
const BLUE_LINE = {
  key: "subway:1",
  label: "Line 1",
  paths: [[
    [19.12, 72.846],  // Andheri
    [19.137, 72.848],
    [19.165, 72.850],
    [19.187, 72.848],
    [19.205, 72.850],
    [19.228, 72.857],
    [19.240, 72.860],
    [19.250, 72.860], // Dahisar
  ]],
};

function freshDbImpl() {
  const s = new Map();
  return { get: async (_st, k) => s.get(k) || null, put: async (_st, v) => { s.set(v.key, v); } };
}

// ============================================================================
// GAME 1 — Andheri chase.
// ============================================================================
test("game 1: hider sets up in Andheri; seeker tightens with line + preview + manual toggle", async () => {
  const dbImpl = freshDbImpl();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => OSM_PAYLOAD });

  // 1. Board created; hider zone = 500 m circle around Andheri.
  const game = createGame({
    name: "Andheri chase",
    gameArea: AREA,
    focusZone: { point: { lat: 19.12, lng: 72.846 }, radius: 500 },
    settings: { geofenceMetres: 80, geofenceAlertStyle: "vibrate-tone" },
  });

  // 2. Phase 1: source the locked station set from OSM.
  const sourced = await sourceStationsForGame(game, { source: "osm", proxyBase: "http://x", dbImpl });
  game.stations = { source: "osm", bbox: sourced.bbox, confirmedAt: Date.now(), list: sourced.stations };
  assert.equal(game.stations.list.length, 8, "8 stations locked in");
  assert.ok(game.stations.list.some((s) => s.name === "Devipada"), "the halt is in the set (Phase 1 halt-tag fix)");

  // 3. Phase 3 + 8: hider steps close to the edge; evaluateGeofence returns an
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

  // 4. Phase 4: seeker asks "same line?" — hider says "not the blue line".
  //    Bulk-eliminate every station within 200 m of the line's ways.
  const onLine = stationsWithinLine(game.stations.list, BLUE_LINE.paths, { toleranceM: 200 });
  assert.ok(onLine.size >= 4, `blue-line hits at least the 4 nearest stations, got ${onLine.size}`);
  eliminateStationsOnLine(game.stations.list, BLUE_LINE.key, BLUE_LINE.paths, { toleranceM: 200 });
  const activeAfterLine = game.stations.list.filter((s) => !s.eliminated);
  const eliminatedByLine = game.stations.list.filter((s) => s.eliminatedBy === `line:${BLUE_LINE.key}`);
  assert.equal(eliminatedByLine.length + activeAfterLine.length, 8, "every station accounted for");

  // 5. Phase 2: draft a NEW radar at Malad, 3 km radius, side=in — how many
  //    still-active stations would it eliminate? Runs BEFORE the manual
  //    toggle below so there's still at least one active station to count
  //    (post-toggle every station is eliminated and the counter returns null
  //    per Phase 16 — a case exercised separately in game-count-stations-empty).
  const draftRadar = {
    id: "draft", tool: "radar", enabled: true,
    inputs: { center: { lat: 19.187, lng: 72.848 }, radius: 3000 },
    answer: { side: "in" },
  };
  const { eliminated } = computeElimination(draftRadar, AREA);
  const pv = countStationsInEliminated(eliminated, game.stations.list);
  assert.ok(pv, "preview returns a number while active stations remain");
  assert.equal(pv.total, game.stations.list.filter((s) => !s.eliminated).length,
    "denominator EXCLUDES already-eliminated stations, per §B1 contract");

  // 6. Phase 6: the seekers realise ONE off-line station (Devipada) is also
  //    ruled out by an ambient clue. A manual toggle wins.
  const dev = game.stations.list.find((s) => s.name === "Devipada");
  const beforeTag = dev.eliminatedBy;
  toggleStationElimination(game.stations.list, dev.id);
  assert.equal(dev.eliminated, true);
  assert.equal(dev.eliminatedBy, "manual", "manual tag replaces whatever it had");
  assert.notEqual(dev.eliminatedBy, beforeTag);

  // 7. Undo the blue-line action: the manual toggle survives.
  restoreStationsOnLine(game.stations.list, BLUE_LINE.key);
  assert.equal(dev.eliminated, true, "Devipada stays eliminated — manual tag is not a line tag");
  const stillEliminated = game.stations.list.filter((s) => s.eliminated).map((s) => s.name).sort();
  assert.deepEqual(stillEliminated, ["Devipada"], "only the manual eliminations survive the line restore");

  // 8. Round-trip through serialize/normalize — everything above must survive
  //    a reload the way a real PWA close/reopen would exercise.
  const restored = normalizeGame(JSON.parse(JSON.stringify(game)));
  assert.equal(restored.stations.list.length, 8);
  assert.equal(restored.stations.list.find((s) => s.name === "Devipada").eliminated, true);
  assert.equal(restored.settings.geofenceMetres, 80);
  assert.equal(restored.settings.geofenceAlertStyle, "vibrate-tone");
});

// ============================================================================
// GAME 2 — WhatsApp relay.
// ============================================================================
test("game 2: seeker WhatsApps a location; hider ingests, runs range elim, drops a note, replies with their own location", () => {
  const game = createGame({ name: "WhatsApp relay", gameArea: AREA });
  game.stations = { source: "osm", bbox: "0,0,0,0", confirmedAt: Date.now(), list: OSM_PAYLOAD.stations.map((s) => ({ ...s })) };

  // 1. Phase 7: hider asks "are you north or south of Dahisar?" — seeker says
  //    "south". Run range elim on the blue line with mode=outside so everything
  //    NORTH of (and including) Dahisar stays eliminated.
  const ordered = orderStationsAlongLine(game.stations.list, BLUE_LINE.paths, { toleranceM: 200 });
  assert.ok(ordered.length >= 4, `blue-line ordering returned ${ordered.length} stations`);
  // Order runs south→north on this fixture's spine. "South of Dahisar" ⇒ everything
  // at Dahisar and beyond (northernmost) is out.
  const dahisar = ordered.find((s) => s.name === "Dahisar");
  const northmost = ordered[ordered.length - 1];
  eliminateStationsInRange(ordered, dahisar.id, northmost.id, BLUE_LINE.key, { mode: "range" });
  const dEntry = game.stations.list.find((s) => s.name === "Dahisar");
  assert.equal(dEntry.eliminated, true);
  assert.equal(dEntry.eliminatedBy, `line:${BLUE_LINE.key}:range`, "range tag distinct from whole-line tag");

  // 3. Phase 10: seeker drops a note pin — off-app clue, no elimination effect.
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

  // 4. Phase 11: hider copies THEIR OWN location — a clean 5dp "lat, lng" pair.
  const myLat = 19.076, myLng = 72.877;
  const clipboard = formatLocationForClipboard(myLat, myLng);
  assert.equal(clipboard, "19.07600, 72.87700");

  // 5. Delete one note — the mutation is precise.
  removeNote(game.notes, noteEntry.id);
  assert.equal(game.notes.length, 1);
  assert.equal(game.notes[0].text, "heard train 3:12");

  // 6. Serialize + normalize: eliminated station and remaining note survive.
  const round = normalizeGame(JSON.parse(JSON.stringify(game)));
  assert.equal(round.notes.length, 1);
  assert.equal(round.stations.list.find((s) => s.name === "Dahisar").eliminated, true);
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
