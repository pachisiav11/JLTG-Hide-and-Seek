// Game data model + factories. Kept plain-JSON-serializable so records can be
// stored in IndexedDB and exported/imported verbatim (see guide §4, §8).

export const SCHEMA_VERSION = 1;

export const TOOLS = ["radar", "thermometer", "matching", "measuring", "tentacles"];

export const DEFAULT_SETTINGS = {
  distanceMode: "straight-line", // "straight-line" | "transit" | "walking"
  units: "metric",               // "metric" | "imperial"
};

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// Build a friendly default game id/name from a date, e.g. game_2026-07-02_1.
function dateStamp(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function createGame(overrides = {}) {
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: overrides.id || uid("game"),
    name: overrides.name || `Game ${dateStamp(now)}`,
    createdAt: overrides.createdAt || now,
    updatedAt: now,
    zones: overrides.zones || [],          // Zone[]
    gameArea: overrides.gameArea || null,  // GeoJSON polygon (turf.union of zones)
    hiderLock: overrides.hiderLock || { locked: false, point: null, stationName: null },
    history: overrides.history || [],      // Step[] — ordered, each toggleable
    settings: { ...DEFAULT_SETTINGS, ...(overrides.settings || {}) },
    // activeArea is DERIVED (not authoritative) — recomputed from gameArea + enabled steps.
  };
}

export function createZone({ id, name, polygon } = {}) {
  return {
    id: id || uid("zone"),
    name: name || "Untitled zone",
    polygon: polygon || [], // [[lat, lng], ...]
  };
}

export function createStep({ tool, inputs = {}, answer = {}, enabled = true } = {}) {
  if (!TOOLS.includes(tool)) {
    throw new Error(`Unknown tool "${tool}". Expected one of: ${TOOLS.join(", ")}`);
  }
  return {
    id: uid("step"),
    tool,
    inputs,   // enough to deterministically recompute the region
    answer,   // yes/no or chosen feature
    enabled,
    createdAt: Date.now(),
  };
}

// Basic shape validation used on import to avoid loading garbage.
export function validateGame(obj) {
  if (!obj || typeof obj !== "object") return "Not an object";
  if (typeof obj.id !== "string") return "Missing id";
  if (!Array.isArray(obj.zones)) return "zones must be an array";
  if (!Array.isArray(obj.history)) return "history must be an array";
  return null; // ok
}

// Normalize an arbitrary loaded object into a full, current-shape Game.
export function normalizeGame(obj) {
  return createGame({
    ...obj,
    settings: obj.settings,
  });
}
