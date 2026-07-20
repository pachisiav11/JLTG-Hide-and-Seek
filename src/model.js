// Game data model + factories. Kept plain-JSON-serializable so records can be
// stored in IndexedDB and exported/imported verbatim (see guide §4, §8).

export const SCHEMA_VERSION = 1;

export const TOOLS = ["radar", "thermometer", "matching", "measuring", "tentacles"];

export const DEFAULT_SETTINGS = {
  distanceMode: "straight-line", // "straight-line" | "transit" | "walking"
  units: "metric",               // "metric" | "imperial"
  questionTimer: 0,              // Phase 11: soft countdown seconds per question (0 = off)
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
    focusZone: overrides.focusZone || { point: null, radius: null }, // solo target zone (point + radius)
    // Locked station set (PLAYTEST_IDEAS §0, cross-cutting). Materialised once at game
    // set-up from OSM (via the Overpass proxy) or from Google Places, then used as the
    // authoritative station domain for the rest of the game — every "eliminate this
    // station", "eliminate this line's stations", and "would eliminate X of Y stations"
    // counter references entries here by id.
    //
    // `list` entries: {id, name, lat, lng, kind, eliminated?, note?}. `id` is stable
    // across refetches (`osm:node/<id>` for OSM, `places:<place_id>` for Places), so a
    // station the seeker eliminated stays eliminated when the set is re-materialised.
    // `source` records how the list was populated; null on a fresh game.
    stations: overrides.stations || { source: null, bbox: null, confirmedAt: null, list: [] },
    history: overrides.history || [],      // Step[] — ordered, each toggleable
    // Step ids undone and awaiting redo, most recent last. Lives on the GAME, not on the
    // Layers instance: as instance state it died on reload, so undoing a question and
    // reloading before pressing Redo made canRedo permanently false for that step.
    // It cannot be derived from history instead — nothing records WHEN a step was disabled,
    // so an undone step is indistinguishable from one toggled off manually long ago.
    redoStack: overrides.redoStack || [],
    // Which rail modes and individual lines are IN PLAY on this board (§G1). Stored as what's
    // HIDDEN, not what's shown, so a mode or line that appears later — a new metro opens, or
    // OSM starts tagging monorails here — defaults to visible rather than silently missing
    // because an older game never listed it.
    //
    // Per GAME, not per app: "we're playing on the Blue and Red lines only" is a property of
    // this board, and the next game on the same city may use different ones.
    railFilter: {
      hiddenRoutes: overrides.railFilter?.hiddenRoutes || [], // OSM route values: "tram", "train", …
      hiddenLines: overrides.railFilter?.hiddenLines || [],   // group keys: "subway:1", "train:W", …
    },
    settings: { ...DEFAULT_SETTINGS, ...(overrides.settings || {}) },
    // Provenance for imports. An import always gets a FRESH id (it must never overwrite an
    // existing game), so this is the only trace of which record it came from. Null for
    // games that were created here rather than imported.
    importedFrom: overrides.importedFrom || null,
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

// Shape validation. Run both on import AND whenever a game is read back from
// IndexedDB (Phase 8), so a corrupted / partially-written record surfaces a clear
// error here instead of throwing deep inside the renderer. Kept lenient about
// optional/derived fields (gameArea, settings) so older valid saves and
// in-progress games still pass — it rejects only structurally broken records.
export function validateGame(obj) {
  if (!obj || typeof obj !== "object") return "Not an object";
  if (typeof obj.id !== "string") return "Missing id";
  if (!Array.isArray(obj.zones)) return "zones must be an array";
  if (!Array.isArray(obj.history)) return "history must be an array";
  // Zones must be objects with a polygon array (the renderer maps over polygon).
  for (let i = 0; i < obj.zones.length; i++) {
    const z = obj.zones[i];
    if (!z || typeof z !== "object") return `zone ${i} is not an object`;
    if (!Array.isArray(z.polygon)) return `zone ${i} has no polygon array`;
    // ...and the polygon's ELEMENTS must be [lat, lng] pairs, which this used to take on trust.
    //
    // `ringToTurf` destructures every vertex (`geo.js:40`), so a ring of `{lat,lng}` objects
    // throws there instead. That throw escaped `addZone`'s store.update mutator, the `pop()`
    // that undoes a refused zone never ran, and the rejected zone stayed on the board with no
    // gameArea rebuilt — the opposite of that guard's purpose. `_fold` now converts the throw
    // (see zones.js), but converting a failure is a worse outcome than never loading the broken
    // board: the player gets a zone list they cannot use and no explanation.
    //
    // This is the shape a game FILE can legally carry today — nothing in the app produces it,
    // but an import is whatever someone hands you.
    for (let v = 0; v < z.polygon.length; v++) {
      const pt = z.polygon[v];
      if (!Array.isArray(pt) || pt.length < 2) return `zone ${i} vertex ${v} is not a [lat, lng] pair`;
      const [lat, lng] = pt;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return `zone ${i} vertex ${v} is not a pair of numbers`;
      if (lat < -90 || lat > 90) return `zone ${i} vertex ${v} has latitude ${lat}, which is off the globe`;
      if (lng < -180 || lng > 180) return `zone ${i} vertex ${v} has longitude ${lng}, which is off the globe`;
    }
    // Deliberately NOT rejecting short or empty rings. `Zones._fold` tolerates them — it skips
    // them and folds the rest — and a test pins that toleration, so refusing them here would
    // reject boards that work today.
  }
  // History steps must be objects naming a known tool (computeElimination switches
  // on step.tool; a bad tool would silently no-op, a non-object would throw).
  for (let i = 0; i < obj.history.length; i++) {
    const s = obj.history[i];
    if (!s || typeof s !== "object") return `history step ${i} is not an object`;
    if (!TOOLS.includes(s.tool)) return `history step ${i} has unknown tool "${s.tool}"`;
    // A step's ANSWER is deliberately not validated here, and that is a decision rather than an
    // omission. An unreadable answer now degrades gracefully — `readSide` eliminates nothing and
    // `describeStep` labels the step "unanswered" — so the board still loads and every other
    // question still works. Rejecting the whole file over one bad answer would throw away a game
    // that is mostly fine, which is the worse trade. A malformed RING has no such graceful
    // reading, which is why that one is refused above.
  }
  if (obj.gameArea != null && typeof obj.gameArea !== "object") return "gameArea must be a polygon object";
  return null; // ok
}

// Normalize an arbitrary loaded object into a full, current-shape Game.
export function normalizeGame(obj) {
  return createGame({
    ...obj,
    settings: obj.settings,
  });
}

// Shape an exported game for import. ALWAYS mints a fresh id.
//
// normalizeGame keeps `overrides.id`, so importing a file exported from this device wrote
// straight over the record already at that key: export mid-session, play three more
// questions, re-import to compare the two, and the import silently destroyed those three
// questions. An import must never be able to overwrite a game.
//
// normalizeGame itself must keep ids — it is also used when LOADING an existing game
// (store.setCurrentSilent), where the id is exactly what you want to preserve. So this is
// a separate step rather than a change to normalizeGame.
export function prepareImport(obj) {
  const { id: sourceId, ...rest } = obj || {};
  return normalizeGame({ ...rest, id: undefined, importedFrom: sourceId || null });
}
