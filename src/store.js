// Game store: owns the "current game" and persists it to IndexedDB with a
// debounced autosave. Higher-level UI talks to this rather than db.js directly.
import * as db from "./db.js";
import { createGame, validateGame, normalizeGame, prepareImport } from "./model.js";

const CURRENT_GAME_KEY = "currentGameId";
const AUTOSAVE_DELAY_MS = 500;

let current = null;
let saveTimer = null;
const listeners = new Set();

function emit() {
  for (const fn of listeners) {
    try { fn(current); } catch (e) { console.error("store listener error", e); }
  }
}

// Subscribe to current-game changes. Returns an unsubscribe fn.
export function subscribe(fn) {
  listeners.add(fn);
  if (current) fn(current);
  return () => listeners.delete(fn);
}

export function getCurrent() {
  return current;
}

// Persist immediately (used on important commits and before unload).
export async function saveNow() {
  if (!current) return;
  current.updatedAt = Date.now();
  await db.put("games", current);
  await db.setSetting(CURRENT_GAME_KEY, current.id);
}

// Debounced autosave — call after any mutation to the current game.
//
// Phase 22 (fix #10): a no-op when there is no IndexedDB. The whole autosave
// path exists to persist to IndexedDB; when it is not available (headless
// node:test runs), scheduling a save just guaranteed a stack trace 500 ms
// after the test function returned — the timer fired past the test boundary
// and db.openDB rejected with 'IndexedDB is not available'. That noise
// misled reads of test output. Callers that actually need to persist under
// node (they don't currently) can still call saveNow() directly and handle
// the reject; scheduleSave() is a fire-and-forget convenience whose only
// customer is the browser event loop.
export function scheduleSave() {
  if (typeof indexedDB === "undefined") return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow().catch((e) => console.error("autosave failed", e));
  }, AUTOSAVE_DELAY_MS);
}

// Mutate the current game via a callback, then autosave + notify.
//
// A mutator that returns exactly `false` reports "I changed nothing", and the save and the
// re-render are both skipped. Some mutators are decided *inside* the callback — `addZone`
// pushes a zone, discovers the union failed, and pops it again; `removeZone` returns early
// when the remaining zones will not fold. Those left the game byte-identical and still cost a
// full game write and a full re-render.
//
// `=== false` and not a falsy test, on purpose: every existing mutator returns undefined, and
// a mutator that happens to end in an expression evaluating to 0 or "" must not silently stop
// persisting the change it just made.
export function update(mutator) {
  if (!current) return;
  const changed = mutator(current);
  if (changed === false) return;
  scheduleSave();
  emit();
}

export function setCurrent(game) {
  current = game;
  scheduleSave();
  emit();
  return current;
}

// Load the last-open game, or create a fresh one if none exists. A record that
// fails validation (corrupted / partially written) is NOT loaded and NOT deleted —
// we log a clear error and start a fresh game so the app still boots, leaving the
// bad record in IndexedDB for possible manual recovery (Phase 8).
export async function init() {
  const lastId = await db.getSetting(CURRENT_GAME_KEY, null);
  if (lastId) {
    const g = await db.get("games", lastId);
    if (g) {
      const err = validateGame(g);
      if (err) {
        console.error(`Last-open game ${lastId} failed validation (${err}); starting a fresh game.`);
      } else {
        return setCurrentSilent(normalizeGame(g));
      }
    }
  }
  // No prior game (or it was invalid) — create and persist a fresh one.
  const g = createGame();
  current = g;
  await saveNow();
  emit();
  return current;
}

// Set current without an extra immediate write (used when loading from DB).
function setCurrentSilent(game) {
  current = game;
  emit();
  return current;
}

export async function listGames() {
  const all = await db.getAll("games");
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function openGame(id) {
  const g = await db.get("games", id);
  if (!g) throw new Error(`Game ${id} not found`);
  // Validate on read (Phase 8): a corrupted record raises a clear error the UI can
  // surface, instead of loading garbage that throws inside the renderer.
  const err = validateGame(g);
  if (err) throw new Error(`This saved game is corrupted (${err}).`);
  await db.setSetting(CURRENT_GAME_KEY, id);
  return setCurrentSilent(normalizeGame(g));
}

export async function newGame(overrides) {
  const g = createGame(overrides);
  current = g;
  await saveNow();
  emit();
  return current;
}

// Blank the CURRENT game in place: drop every zone, the game area, all questions
// but keep the same game id/name/settings (so it stays the
// same saved game, just emptied). Used by "Clear board" to wipe a map that was
// restored from a previous session without spawning a new game record.
export async function clearBoard() {
  if (!current) return;
  current.zones = [];
  current.gameArea = null;
  current.history = [];
  current.focusZone = { point: null, radius: null };
  current.stations = { source: null, bbox: null, confirmedAt: null, list: [] };
  current.seekerLocation = null;
  current.notes = [];
  // These two were left behind, and both outlive the board they belonged to.
  //
  // `redoStack` holds steps whose geometry refers to zones that no longer exist, so Redo on a
  // cleared board re-adds a question about an area that is gone — it computes against the NEW
  // gameArea and eliminates somewhere arbitrary, or against null and does nothing. Either way
  // the seeker did not ask it.
  //
  // `railFilter` is per-board by nature ("we're only playing on these lines"). Carried into a
  // fresh board it silently hides lines from candidateLines — including the Matching transit
  // card, where the filter is now load-bearing — so a new game in a new city could open with
  // another city's lines excluded and nothing on screen saying so.
  current.redoStack = [];
  current.railFilter = { hiddenRoutes: [], hiddenLines: [] };
  await saveNow();
  emit();
  return current;
}

export async function deleteGame(id) {
  await db.del("games", id);
  if (current && current.id === id) {
    current = null;
    await db.setSetting(CURRENT_GAME_KEY, null);
    return init();
  }
}

// Export the current (or given) game as a JSON string for backup/sharing.
// Prefer the in-memory current game so a fresh export never lags the debounced
// autosave; only read the DB for a different, non-current game.
export async function exportGame(id) {
  const g = !id || (current && id === current.id) ? current : await db.get("games", id);
  return JSON.stringify(g, null, 2);
}

// Import a game from a JSON string. Returns the imported game.
export async function importGame(json) {
  const obj = typeof json === "string" ? JSON.parse(json) : json;
  const err = validateGame(obj);
  if (err) throw new Error(`Invalid game file: ${err}`);
  // Always mints a fresh id so an import can never overwrite an existing game — see
  // prepareImport. (duplicate() gets this right the same way, by stripping id first.)
  const g = prepareImport(obj);
  await db.put("games", g);
  return g;
}

// Flush pending save on page hide/unload.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { saveNow(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveNow();
  });
}
