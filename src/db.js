// Minimal, dependency-free IndexedDB wrapper for the JLTG app.
// Database `jltg` with six stores — the count is the FIRST thing to update when one is added
// or dropped. It said "five" while creating seven for three phases running (B10), which is how
// a header stops being documentation and starts being a wrong answer someone trusts.
//   - games      (keyPath "id")  — full Game records (see model.js)
//   - zones      (keyPath "id")  — reusable named zone polygons (zone library, Phase 1)
//   - categories (keyPath "id")  — reusable custom Places categories (Phase 9)
//   - pins       (keyPath "id")  — reusable named location pins (Phase 9)
//   - lines      (keyPath "key") — cached Overpass linear geometry per bbox (§G1)
//   - settings   (keyPath "key") — lightweight app-wide settings
const DB_NAME = "jltg";
const DB_VERSION = 5;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not available in this browser."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("games")) {
        const games = db.createObjectStore("games", { keyPath: "id" });
        games.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains("zones")) {
        db.createObjectStore("zones", { keyPath: "id" });
      }
      // Added in DB_VERSION 2 (Phase 9). guarded by contains() so the upgrade is
      // idempotent whether coming from a v1 database or a fresh install.
      if (!db.objectStoreNames.contains("categories")) {
        db.createObjectStore("categories", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("pins")) {
        db.createObjectStore("pins", { keyPath: "id" });
      }
      // DB_VERSION 3 (Phase 13) created an `outbox` store for offline-queued multiplayer
      // events. Nothing ever read or wrote it and the relay it belonged to is gone, so v5
      // drops it. Deleted rather than left in place: an empty store with a name that implies
      // pending work is a standing invitation to misread the schema.
      if (db.objectStoreNames.contains("outbox")) {
        db.deleteObjectStore("outbox");
      }
      // Added in DB_VERSION 4 (§G1): rail/coastline/border geometry from Overpass, keyed by
      // kind+level+bbox. Cached hard because it is effectively static, the fetch is slow and
      // fails often, and unlike a tile overlay this survives offline — which is the point on a
      // board where you are walking around with no signal.
      if (!db.objectStoreNames.contains("lines")) {
        db.createObjectStore("lines", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function put(store, value) {
  const db = await openDB();
  await wrap(tx(db, store, "readwrite").put(value));
  return value;
}

export async function get(store, key) {
  const db = await openDB();
  return wrap(tx(db, store, "readonly").get(key));
}

export async function getAll(store) {
  const db = await openDB();
  return wrap(tx(db, store, "readonly").getAll());
}

export async function del(store, key) {
  const db = await openDB();
  return wrap(tx(db, store, "readwrite").delete(key));
}

export async function clear(store) {
  const db = await openDB();
  return wrap(tx(db, store, "readwrite").clear());
}

// Settings convenience helpers (key/value).
export async function getSetting(key, fallback = null) {
  const row = await get("settings", key);
  return row ? row.value : fallback;
}
export async function setSetting(key, value) {
  return put("settings", { key, value });
}
