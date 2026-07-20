// Locked station set (PLAYTEST_IDEAS §0, cross-cutting).
//
// The first-real-world playtest ended AT Devipada — but the app has no concept of
// "the stations for this game". Range-elimination (Q0 "not past Dahisar"), whole-line
// exclusion (Q1 "not the blue line"), and name-length matching with visible cross-outs
// (Q5) all need the same thing: an explicit, tappable, per-game collection of stations
// with stable ids and known positions.
//
// This module is the sourcing side. The panel that shows / edits / confirms the set
// lives in src/games.js; the persisted shape lives in game.stations (src/model.js).
// Consumers (A3/A4/A5, and the "would eliminate X of Y stations" counter in B1) key
// off station ids from the game's list, so those ids must be stable across refetches —
// hence `osm:node/<id>` for OSM and `places:<place_id>` for Google Places.

import * as db from "./db.js";
import { boardBbox } from "./lines.js";

// Rail geometry TTL is 30 days; stations move even less often, but the same reasoning
// applies — a month-old station list beats an empty list outdoors on a phone with no
// signal, and the ladder falls back to a stale cache explicitly rather than pretending
// the network was fine.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Bump when the OSM payload shape changes. Same reason as lines.js's PAYLOAD_VERSION:
// without it, a cached entry in the old shape is served silently for 30 days after the
// fix ships. `source` is part of the key because OSM and Places return different
// (overlapping) sets and their entries have different ids.
export const STATIONS_VERSION = 1;
export const stationsCacheKey = (source, bbox) => `stations:v${STATIONS_VERSION}:${source}:${bbox}`;

const PROXY_FETCH_TIMEOUT_MS = 60000;

async function fetchFromProxy(proxyBase, bbox) {
  const url = new URL(proxyBase.replace(/\/+$/, "") + "/overpass/stations");
  url.searchParams.set("bbox", bbox);
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS) });
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json())?.error || ""; } catch { /* non-JSON body */ }
    throw Object.assign(new Error(detail || `Stations proxy HTTP ${resp.status}`), { status: resp.status });
  }
  return resp.json();
}

// Cache-first, then network, then STALE cache. Mirrors lines.js:loadLines exactly, on
// purpose: a station set has the same "played outdoors, on a phone" failure profile as
// rail geometry, and a divergent recovery ladder would just be another place a
// month-old copy sits unused while the map goes blank. `dbImpl` is injectable for tests.
export async function loadStationsFromOsm(bbox, { proxyBase = null, now = Date.now(), dbImpl = db } = {}) {
  const key = stationsCacheKey("osm", bbox);
  let cached = null;
  try { cached = await dbImpl.get("lines", key); } catch { /* IndexedDB unavailable — network only */ }

  if (cached && now - cached.fetchedAt < TTL_MS) return { ...cached.data, from: "cache" };
  if (!proxyBase) {
    if (cached) return { ...cached.data, from: "cache-stale" };
    throw new Error("No Overpass proxy configured (set OVERPASS_PROXY_URL in config.js).");
  }

  try {
    const data = await fetchFromProxy(proxyBase, bbox);
    try { await dbImpl.put("lines", { key, source: "osm", bbox, fetchedAt: now, data }); } catch { /* over quota */ }
    return { ...data, from: "network" };
  } catch (err) {
    if (cached) return { ...cached.data, from: "cache-stale", error: err.message };
    throw err;
  }
}

// Places fallback: uses the same nearbySearch pagination as places.searchCategory (up
// to 3 pages, ~60 results). Signature mirrors loadStationsFromOsm so the picker can
// swap sources without special-casing. `map` is a Google Maps instance (the Places API
// needs a map reference), `bbox` is the same S,W,N,E string.
//
// `placesImpl` is injectable so a test doesn't need a live Google Places to exercise
// the "user picked Places" branch. Production callers pass window's real Places wrapper.
export async function loadStationsFromPlaces(bbox, { placesImpl } = {}) {
  if (!placesImpl?.searchCategory) {
    throw new Error("Google Places is not available (no API key or Places script not loaded).");
  }
  const [s, w, n, e] = String(bbox).split(",").map(Number);
  if (![s, w, n, e].every(Number.isFinite)) throw new Error(`Malformed bbox "${bbox}"`);
  // nearbySearch is circular — turn the bbox into a centre + a radius that reaches its
  // furthest corner, so a search from the middle covers the whole board. Google caps
  // the radius at 50 km server-side, so on any board wider than ~100 km the corners get
  // clipped; that is a known cap of the Places source, not a bug of this module, and
  // the OSM picker is the answer for wide boards.
  const center = { lat: (s + n) / 2, lng: (w + e) / 2 };
  const R = 6371000;
  const dLat = ((n - s) / 2) * Math.PI / 180;
  const lat0 = center.lat * Math.PI / 180;
  const dLng = ((e - w) / 2) * Math.PI / 180 * Math.cos(lat0);
  const radius = R * Math.hypot(dLat, dLng);
  const raw = await placesImpl.searchCategory({ center, radius, type: "transit_station" });
  const stations = [];
  const seen = new Set();
  for (const r of raw || []) {
    if (!r?.name || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue;
    // Filter to the actual bbox — nearbySearch's circle overshoots the corners into
    // ground that isn't part of the board.
    if (r.lat < s || r.lat > n || r.lng < w || r.lng > e) continue;
    const id = r.placeId ? `places:${r.placeId}` : `places:${r.lat.toFixed(5)},${r.lng.toFixed(5)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    stations.push({ id, name: r.name, lat: r.lat, lng: r.lng, kind: "places" });
  }
  stations.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { stations, counts: { raw: (raw || []).length, kept: stations.length }, from: "network" };
}

// Turn a game + a source pick into the station list the game should lock in. Board
// bbox is derived from the game's own area, so the returned set covers exactly the
// ground the game is played on — a station 30 km beyond the board is not a candidate
// answer to any question here.
export async function sourceStationsForGame(game, { source = "osm", proxyBase = null, placesImpl = null, dbImpl = db, now = Date.now() } = {}) {
  const bbox = boardBbox(game?.gameArea);
  if (!bbox) throw new Error("Draw a game area first — stations are sourced for the board.");
  if (source === "osm") {
    const proxy = proxyBase ?? (typeof window !== "undefined" ? window.JLTG_CONFIG?.OVERPASS_PROXY_URL || null : null);
    const data = await loadStationsFromOsm(bbox, { proxyBase: proxy, now, dbImpl });
    return { ...data, source: "osm", bbox };
  }
  if (source === "places") {
    const data = await loadStationsFromPlaces(bbox, { placesImpl });
    return { ...data, source: "places", bbox };
  }
  throw new Error(`Unknown station source "${source}" (expected "osm" or "places").`);
}
