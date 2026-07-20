// Phase 10 (§C1) game test: note pins persist per-game, survive save/reload,
// and update/delete atomically.
//
// The playtest scenario: Q4 "photo of a building" — the seekers looked at a
// photo, ruled out a candidate area. Before Phase 10, they'd say it out loud
// and forget it by the next round. After: they long-press the map, drop a
// pin labelled "photo — mall not near here", and the note stays with the
// game.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/turf-env.mjs";
import { createGame, normalizeGame } from "../src/model.js";
import { addNote, updateNote, removeNote } from "../src/notes.js";

test("game 1: adding a note pins it with a stable id + timestamp", () => {
  const g = createGame({ name: "Q4 photo" });
  assert.deepEqual(g.notes, [], "fresh games have an empty note list");
  const n = addNote(g.notes, { lat: 19.24, lng: 72.87 }, "photo shows a mall not near here", { at: 12345, id: "note_1" });
  assert.equal(g.notes.length, 1);
  assert.equal(n.id, "note_1");
  assert.equal(n.text, "photo shows a mall not near here");
  assert.equal(n.at, 12345);
});

test("game 2: notes survive save/reload", () => {
  const g = createGame({ name: "persistence" });
  addNote(g.notes, { lat: 19.10, lng: 72.85 }, "heard a train pass at 3:12", { id: "note_a" });
  addNote(g.notes, { lat: 19.20, lng: 72.87 }, "seeker mentioned this area", { id: "note_b" });
  const reopened = normalizeGame(JSON.parse(JSON.stringify(g)));
  assert.equal(reopened.notes.length, 2);
  assert.deepEqual(reopened.notes.map((n) => n.id).sort(), ["note_a", "note_b"]);
});

test("game 3: updateNote changes text in place — id stable, timestamp stable", () => {
  const g = createGame({ name: "edit" });
  addNote(g.notes, { lat: 19.24, lng: 72.87 }, "first thought", { at: 100, id: "note_1" });
  updateNote(g.notes, "note_1", "second thought — actually not that");
  assert.equal(g.notes.length, 1);
  assert.equal(g.notes[0].text, "second thought — actually not that");
  assert.equal(g.notes[0].id, "note_1", "id must not change on edit — the map marker keys off it");
  assert.equal(g.notes[0].at, 100, "the ORIGINAL timestamp survives; edit is not a re-drop");
});

test("game 4: removeNote is by id, atomic — everything else untouched", () => {
  const g = createGame({ name: "delete" });
  addNote(g.notes, { lat: 1, lng: 1 }, "a", { id: "a" });
  addNote(g.notes, { lat: 2, lng: 2 }, "b", { id: "b" });
  addNote(g.notes, { lat: 3, lng: 3 }, "c", { id: "c" });
  assert.equal(removeNote(g.notes, "b"), true);
  assert.deepEqual(g.notes.map((n) => n.id), ["a", "c"]);
  assert.equal(removeNote(g.notes, "missing"), false);
});

test("game 5: update/remove on missing ids do not crash and do not mutate", () => {
  const g = createGame({ name: "missing" });
  addNote(g.notes, { lat: 0, lng: 0 }, "kept", { id: "keep" });
  assert.equal(updateNote(g.notes, "not-there", "x"), null);
  assert.equal(removeNote(g.notes, "not-there"), false);
  assert.equal(g.notes.length, 1);
  assert.equal(g.notes[0].text, "kept");
});

test("game 6: empty text is allowed — a pin with a fresh mental note gets a label later", () => {
  const g = createGame({ name: "empty" });
  const n = addNote(g.notes, { lat: 19, lng: 72 }, "");
  assert.equal(n.text, "");
  updateNote(g.notes, n.id, "photo of a temple");
  assert.equal(g.notes[0].text, "photo of a temple");
});
