// C1 — importing a game must never overwrite the game it shares an id with.
//
// normalizeGame -> createGame({...obj}) -> `id: overrides.id || uid("game")` kept the
// SOURCE id, then db.put("games", g) wrote straight over the record already at that key.
// Export mid-session, play three more questions, re-import to compare the two, and the
// import silently destroyed those three questions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame, normalizeGame, validateGame, prepareImport } from "../src/model.js";

const exported = (over = {}) => ({
  schemaVersion: 1,
  id: "game_original_abc",
  name: "Mumbai Run",
  createdAt: 1,
  zones: [{ id: "z1", name: "Zone", polygon: [[19, 72], [19, 73], [20, 73]] }],
  gameArea: null,
  history: [],
  settings: { units: "metric" },
  ...over,
});

// The REAL function importGame calls. Testing a local mirror of the rule would pass even
// if importGame did something else entirely.
const importShape = prepareImport;

test("an imported game gets a FRESH id, never the source's", () => {
  const src = exported();
  const g = importShape(src);
  // The precise regression: this used to equal "game_original_abc", so db.put overwrote it.
  assert.notEqual(g.id, src.id);
  assert.match(g.id, /^game_/);
});

test("two imports of the same file produce two distinct games", () => {
  const src = exported();
  const a = importShape(src);
  const b = importShape(src);
  assert.notEqual(a.id, b.id, "re-importing must not collide with the first import either");
});

test("provenance is kept, so the copy is traceable to its source", () => {
  const g = importShape(exported());
  assert.equal(g.importedFrom, "game_original_abc");
});

test("a game created here has no provenance", () => {
  assert.equal(createGame({ name: "Fresh" }).importedFrom, null);
});

test("the imported content survives — only the id changes", () => {
  const src = exported({ name: "Keep My Name" });
  const g = importShape(src);
  assert.equal(g.name, "Keep My Name");
  assert.equal(g.createdAt, 1);
  assert.deepEqual(g.zones, src.zones);
  assert.equal(g.settings.units, "metric");
});

test("normalizeGame still PRESERVES ids — it is also used to load existing games", () => {
  // store.js calls normalizeGame when reading a game back (setCurrentSilent). Minting a
  // fresh id there would orphan every saved game, so the fix must live in importGame only.
  const g = normalizeGame(exported());
  assert.equal(g.id, "game_original_abc");
});

test("validateGame still requires an id on the incoming FILE", () => {
  // The file must identify itself; it is the stored copy that gets a new id.
  assert.equal(validateGame(exported()), null);
  const { id, ...noId } = exported();
  assert.match(String(validateGame(noId)), /id/i);
});

test("a file with no id still imports rather than throwing", () => {
  const { id, ...noId } = exported();
  const g = importShape(noId);
  assert.match(g.id, /^game_/);
  assert.equal(g.importedFrom, null);
});
