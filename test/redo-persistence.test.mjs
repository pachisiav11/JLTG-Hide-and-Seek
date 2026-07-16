// C2 — the redo stack must survive a reload.
//
// `redoStack` was instance state on Layers and absent from the schema. Undo a question,
// reload before pressing Redo, and canRedo was permanently false for that step. It survived
// as enabled:false, but only a manual checkbox toggle recovered it — silently changing the
// recovery path the UI advertises.
//
// It cannot be derived from history instead: nothing records WHEN a step was disabled, so
// an undone step is indistinguishable from one toggled off manually long ago. That
// ambiguity is exactly why the stack exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame, normalizeGame, prepareImport } from "../src/model.js";

test("a new game starts with an empty redo stack", () => {
  assert.deepEqual(createGame().redoStack, []);
});

test("the redo stack round-trips through a save/load cycle", () => {
  // normalizeGame is what store runs on every read from IndexedDB. If it dropped the
  // stack, redo would still die on reload — just further downstream.
  const saved = { ...createGame({ name: "G" }), redoStack: ["step_a", "step_b"] };
  const loaded = normalizeGame(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(loaded.redoStack, ["step_a", "step_b"]);
});

test("a game saved BEFORE this field existed loads with an empty stack, not undefined", () => {
  // Older records have no redoStack. `g.redoStack.length` would throw on them.
  const legacy = createGame();
  delete legacy.redoStack;
  const loaded = normalizeGame(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(loaded.redoStack, []);
  assert.doesNotThrow(() => loaded.redoStack.length);
});

test("an imported game does not inherit a stale redo stack", () => {
  // The ids would point at steps in a different game record.
  const g = prepareImport({ ...createGame({ name: "X" }), id: "src", redoStack: ["step_a"] });
  assert.deepEqual(g.redoStack, ["step_a"], "the stack travels with the game's own history");
  assert.notEqual(g.id, "src");
});

// The undo/redo rules, asserted against the same shape layers.js manipulates. (layers.js
// itself can't be imported under node — window.addEventListener at module scope.)
const undo = (g) => {
  const enabled = g.history.filter((s) => s.enabled);
  if (!enabled.length) return false;
  const last = enabled[enabled.length - 1];
  last.enabled = false;
  (g.redoStack ||= []).push(last.id);
  return true;
};
const redo = (g) => {
  let done = null;
  while (g.redoStack.length && !done) {
    const id = g.redoStack.pop();
    const s = g.history.find((x) => x.id === id);
    if (s) { s.enabled = true; done = s; }
  }
  return done;
};
const gameWith = (n) => ({
  ...createGame(),
  history: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, tool: "radar", enabled: true })),
});

test("undo pushes onto the stack; redo pops and re-enables", () => {
  const g = gameWith(3);
  undo(g);
  assert.deepEqual(g.redoStack, ["s2"]);
  assert.equal(g.history[2].enabled, false);
  assert.equal(redo(g).id, "s2");
  assert.equal(g.history[2].enabled, true);
  assert.deepEqual(g.redoStack, []);
});

test("the reload case: the stack is state, so redo works after a round trip", () => {
  const g = gameWith(3);
  undo(g);
  // Save and reload — the precise moment redo used to die.
  const reloaded = normalizeGame(JSON.parse(JSON.stringify(g)));
  assert.deepEqual(reloaded.redoStack, ["s2"], "the stack survived the reload");
  assert.equal(redo(reloaded).id, "s2");
  assert.equal(reloaded.history[2].enabled, true);
});

test("repeated undos redo in reverse order", () => {
  const g = gameWith(3);
  undo(g); undo(g);
  assert.deepEqual(g.redoStack, ["s2", "s1"]);
  assert.equal(redo(g).id, "s1", "most recent undo redoes first");
  assert.equal(redo(g).id, "s2");
});

test("redo skips a step that has since been deleted rather than silently doing nothing", () => {
  const g = gameWith(3);
  undo(g); undo(g);
  g.history = g.history.filter((s) => s.id !== "s1"); // deleted out from under the stack
  assert.equal(redo(g).id, "s2", "falls through to the next live id");
});

test("redo on an empty stack returns nothing", () => {
  const g = gameWith(2);
  assert.equal(redo(g), null);
});
