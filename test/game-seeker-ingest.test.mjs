// Phase 5 game test: A2 WhatsApp intake, end to end.
//
// The playtest scenario: the seeker types their location into WhatsApp, the hider
// long-presses it and pastes into JLTG. Two shapes are common — bare "lat, lng"
// and a Google Maps URL. Both must resolve to a stored seekerLocation the game
// can use, survive save/reload, and be picked up by the radar/thermometer setup
// flows.
import test from "node:test";
import assert from "node:assert/strict";
import { squareArea } from "./helpers/turf-env.mjs";
import { createGame, normalizeGame } from "../src/model.js";
import { parseSeekerLocation } from "../src/ingest.js";

const AREA = squareArea([72.8777, 19.076], 0.4);

// Simulate the two-step flow the panel does: parse the paste, apply it.
function applyPaste(game, text, now = Date.now()) {
  const parsed = parseSeekerLocation(text);
  if (!parsed) return false;
  game.seekerLocation = { lat: parsed.lat, lng: parsed.lng, at: now, source: parsed.source };
  return true;
}

test("game 1: hider pastes a bare 'lat, lng' from WhatsApp — accepted, stored, survives save+reload", () => {
  const g = createGame({ name: "Playtest replay", gameArea: AREA });
  assert.equal(g.seekerLocation, null, "fresh games start with no seeker location");

  const ok = applyPaste(g, "19.15, 72.85", 1_720_000_000_000);
  assert.equal(ok, true);
  assert.equal(g.seekerLocation.lat, 19.15);
  assert.equal(g.seekerLocation.lng, 72.85);
  assert.equal(g.seekerLocation.source, "pair");
  assert.ok(g.seekerLocation.at, "the paste is timestamped so the hider can gauge staleness");

  // Serialise + reopen — this is the PWA close-and-reopen path.
  const reopened = normalizeGame(JSON.parse(JSON.stringify(g)));
  assert.deepEqual(reopened.seekerLocation, g.seekerLocation);
});

test("game 2: hider pastes a Google Maps URL instead — same outcome", () => {
  // The 3-tap flow described in PLAYTEST_IDEAS §A2 step 2: seeker opens the
  // WhatsApp location attachment, taps "View on map", copies the URL, sends it.
  const g = createGame({ name: "URL paste", gameArea: AREA });
  const url = "https://www.google.com/maps/place/@19.076,72.8777,15z/data=!3m1";
  const ok = applyPaste(g, url);
  assert.equal(ok, true);
  assert.equal(g.seekerLocation.lat, 19.076);
  assert.equal(g.seekerLocation.lng, 72.8777);
  assert.equal(g.seekerLocation.source, "gmaps-at");
});

test("game 3: a garbage paste is refused — no silent zeroing of the seeker location", () => {
  // The failure mode this prevents is real: an accidental partial paste
  // ("Route: 5 blocks north") that ends up matching an integer pair somewhere
  // and silently anchors the radar at (0, 0). The parser refuses; the panel
  // should show a message. Nothing on game.seekerLocation should change.
  const g = createGame({ name: "Bad paste", gameArea: AREA });
  const prior = { lat: 19.15, lng: 72.85, at: 1000, source: "pair" };
  g.seekerLocation = { ...prior };

  const ok = applyPaste(g, "Meet me at Central Station in 10 min");
  assert.equal(ok, false);
  assert.deepEqual(g.seekerLocation, prior, "a failed parse must NOT overwrite the last-known good location");
});

test("game 4: a new paste replaces the old one — 'one active at a time' contract", () => {
  const g = createGame({ name: "Sequential pastes", gameArea: AREA });
  applyPaste(g, "19.10, 72.85", 1000);
  applyPaste(g, "19.20, 72.87", 2000);
  assert.equal(g.seekerLocation.lat, 19.20);
  assert.equal(g.seekerLocation.at, 2000, "timestamp reflects the newest paste");
});

test("game 5: seeker-location AND the locked station set coexist — the two intakes don't step on each other", () => {
  // A hider mid-game has BOTH a materialised station set (Phase 1) AND a fresh
  // seeker location paste (Phase 5). Neither should affect the other's storage;
  // the round-trip through save/reload proves it.
  const g = createGame({ name: "Combined", gameArea: AREA });
  g.stations = { source: "osm", bbox: null, confirmedAt: 1_500, list: [{ id: "osm:node/1", name: "A", lat: 19.1, lng: 72.85 }] };
  applyPaste(g, "19.076, 72.8777");
  const reopened = normalizeGame(JSON.parse(JSON.stringify(g)));
  assert.equal(reopened.stations.list.length, 1);
  assert.equal(reopened.seekerLocation.lat, 19.076);
  assert.equal(reopened.stations.confirmedAt, 1500, "the station lock survived");
});
