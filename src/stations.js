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

// Which stations belong to a given rail line, computed as the ids of any station
// within `toleranceM` metres of any way in the line. Client-side heuristic so this
// works without a server round trip — the OSM route relations that would give an
// authoritative membership are a bigger payload to fetch and would block A4 on the
// (currently broken) backend redeploy.
//
// A rail line's `paths` is a list of polylines in [lat, lng] order (the shape lines.js
// produces via `groupIntoLines`). A station is "on" the line if it lies within the
// tolerance of any single one of them — a real station a hider names is typically at
// the edge of the track (platforms sit 5-25 m off centre) and OSM's `railway=station`
// node is usually a few metres off the way, so 100 m is a comfortable default with
// room for OSM tagging noise.
//
// Returns a Set of station ids so callers can test membership in O(1) and build the
// bulk actions the Stations panel needs. Nothing here mutates the stations.
const DEFAULT_LINE_TOLERANCE_M = 100;

export function stationsWithinLine(stations, wayPaths, { toleranceM = DEFAULT_LINE_TOLERANCE_M } = {}) {
  const hits = new Set();
  if (!Array.isArray(stations) || !stations.length) return hits;
  if (!Array.isArray(wayPaths) || !wayPaths.length) return hits;
  if (typeof window === "undefined" || !window.turf) return hits;
  const turf = window.turf;
  // Precompute LineStrings once — a Mumbai-scale line can be 30+ ways, and one
  // turf.lineString per station-per-way is otherwise the hot path.
  const lines = [];
  for (const p of wayPaths) {
    if (!Array.isArray(p) || p.length < 2) continue;
    try { lines.push(turf.lineString(p.map(([lat, lng]) => [lng, lat]))); }
    catch (_) { /* a malformed way must not veto the rest */ }
  }
  if (!lines.length) return hits;
  const tolKm = toleranceM / 1000;
  for (const s of stations) {
    if (!Number.isFinite(s?.lat) || !Number.isFinite(s?.lng)) continue;
    const pt = turf.point([s.lng, s.lat]);
    for (const ls of lines) {
      let d;
      try { d = turf.pointToLineDistance(pt, ls, { units: "kilometers" }); }
      catch (_) { continue; }
      if (d <= tolKm) { hits.add(s.id); break; }
    }
  }
  return hits;
}

// A4 bulk action: mark every station on the given line as eliminated, tagged with
// `line:<key>` so a later "restore this line" un-eliminates exactly those and not
// the ones the seeker had already marked out for other reasons.
//
// A station previously eliminated with `eliminatedBy = "manual"` is deliberately
// SKIPPED: the tap-a-station action (Phase 6) is a directly reasoned deduction —
// a clue photo, a hider slip — and a later bulk rule must not silently overwrite
// its tag, because a subsequent `restoreStationsOnLine` would then un-eliminate
// it via the line tag it never should have carried. Line-vs-line clobber is a
// different case: game 6 in game-line-elimination.test.mjs pins the "later
// line rule wins" convention, and this fix does not touch it.
//
// Returns the mutation as a list of {id, wasEliminated, wasBy} so a caller can
// build a fold-style undo (Phase 4 does not create a real fold step — the station
// list is not a fold input — but the undo shape is worth preserving anyway).
export function eliminateStationsOnLine(stationsList, lineKey, wayPaths, opts = {}) {
  const hits = stationsWithinLine(stationsList, wayPaths, opts);
  const changed = [];
  for (const s of stationsList) {
    if (!hits.has(s.id)) continue;
    if (s.eliminatedBy === "manual") continue;
    changed.push({ id: s.id, wasEliminated: !!s.eliminated, wasBy: s.eliminatedBy || null });
    s.eliminated = true;
    s.eliminatedBy = `line:${lineKey}`;
  }
  return { changed, hitIds: [...hits] };
}

// Inverse of the above. Restores only the stations this line eliminated — a station
// the seeker marked out MANUALLY (or via a different line) keeps its state. That is
// the whole reason `eliminatedBy` exists: a bulk restore must not undo unrelated
// work.
export function restoreStationsOnLine(stationsList, lineKey) {
  const tag = `line:${lineKey}`;
  const changed = [];
  for (const s of stationsList) {
    if (s.eliminatedBy !== tag) continue;
    changed.push({ id: s.id });
    s.eliminated = false;
    s.eliminatedBy = null;
  }
  return { changed };
}

// Phase 7 (A5): order stations along a line, so a range action ("everything past
// Dahisar", playtest Q0) has something meaningful to iterate over.
//
// A rail line's `paths` is many ways, not a single polyline, and OSM does not
// guarantee they connect head-to-tail. The full correct ordering would need to
// stitch ways in the right order at the right endpoints, which is a real graph
// problem — and one this feature doesn't need. What it DOES need is a stable
// ordering that reads as "north end to south end" (or "airport to city centre")
// on a typical metro line.
//
// The chosen approximation: project every on-line station onto the LONGEST way
// in the line — the spine — and sort by distance along it. On a real metro line
// the longest way is almost always the trunk and the shorter ways are branches;
// stations on branches still project cleanly onto the trunk and end up in
// roughly the right place. Where this is wrong (a line whose ways are all
// branches with no dominant trunk) the range picker still offers all stations
// on the line — just possibly not in walking order.
export function orderStationsAlongLine(stations, wayPaths, { toleranceM } = {}) {
  const hits = stationsWithinLine(stations, wayPaths, toleranceM ? { toleranceM } : undefined);
  const onLine = stations.filter((s) => hits.has(s.id));
  if (!onLine.length || typeof window === "undefined" || !window.turf) return onLine;
  const turf = window.turf;
  // Pick the longest way (by point count as a proxy for length) as the spine.
  let spine = null;
  for (const p of wayPaths) if (Array.isArray(p) && (!spine || p.length > spine.length)) spine = p;
  if (!spine || spine.length < 2) return onLine;
  let line;
  try { line = turf.lineString(spine.map(([lat, lng]) => [lng, lat])); }
  catch (_) { return onLine; }
  const withKey = [];
  for (const s of onLine) {
    let key = 0;
    try {
      const np = turf.nearestPointOnLine(line, turf.point([s.lng, s.lat]));
      key = np?.properties?.location ?? 0;
    } catch (_) { /* keep key=0 — station sorts to the start rather than dropping */ }
    withKey.push({ s, key });
  }
  withKey.sort((a, b) => a.key - b.key);
  return withKey.map((x) => x.s);
}

// Phase 7: eliminate a CONTIGUOUS range of stations on an already-ordered list.
// `fromId` and `toId` name the endpoints (inclusive); the mutator flips the
// range's `eliminated` flag and tags each with `line:<key>:range` so a later
// "restore this range" undoes exactly what this call did without touching manual
// eliminations or other range actions.
//
// `mode`: "range" eliminates from → to inclusive; "outside" eliminates
// everything NOT in the range (the natural shape of playtest Q0 — "hider is
// SOUTH of Dahisar, so eliminate everything from Dahisar northward").
export function eliminateStationsInRange(orderedList, fromId, toId, lineKey, { mode = "range" } = {}) {
  const fromIdx = orderedList.findIndex((s) => s.id === fromId);
  const toIdx = orderedList.findIndex((s) => s.id === toId);
  if (fromIdx < 0 || toIdx < 0) return { changed: [] };
  const lo = Math.min(fromIdx, toIdx), hi = Math.max(fromIdx, toIdx);
  const inRange = (i) => i >= lo && i <= hi;
  const tag = `line:${lineKey}:range`;
  const changed = [];
  for (let i = 0; i < orderedList.length; i++) {
    const s = orderedList[i];
    const shouldEliminate = mode === "outside" ? !inRange(i) : inRange(i);
    if (!shouldEliminate) continue;
    // Same manual-tag preservation as eliminateStationsOnLine above.
    if (s.eliminatedBy === "manual") continue;
    changed.push({ id: s.id, wasEliminated: !!s.eliminated, wasBy: s.eliminatedBy || null });
    s.eliminated = true;
    s.eliminatedBy = tag;
  }
  return { changed, lineKey };
}

// The counterpart to eliminateStationsInRange: restore only the stations THIS
// range action tagged. Mirrors restoreStationsOnLine — a manual elimination or
// a whole-line rule stays intact.
export function restoreStationsInRange(list, lineKey) {
  const tag = `line:${lineKey}:range`;
  const changed = [];
  for (const s of list) {
    if (s.eliminatedBy !== tag) continue;
    changed.push({ id: s.id });
    s.eliminated = false;
    s.eliminatedBy = null;
  }
  return { changed };
}

// Phase 6 (A3): toggle a single station's `eliminated` flag by id, applying the
// same convention as the Stations panel (`eliminatedBy = "manual"` when the user
// flips it themselves). Returns the new state so a caller can toast an accurate
// "eliminated" / "restored" message. Pure — no store touch — so it lives here
// with the other station mutators rather than in the layer-rendering class.
export function toggleStationElimination(list, id) {
  const entry = Array.isArray(list) ? list.find((s) => s.id === id) : null;
  if (!entry) return null;
  const wasEliminated = !!entry.eliminated;
  entry.eliminated = !wasEliminated;
  entry.eliminatedBy = entry.eliminated ? "manual" : null;
  return { id, eliminated: entry.eliminated, wasEliminated };
}

// The count the B1 draft-mode preview shows: "N of Y active stations would be
// eliminated by this pending step". Pure — takes an already-computed eliminated
// geometry rather than recomputing, so a caller that has run `computeElimination`
// once (the layers.js preview does exactly this) does not run it twice.
//
// Stations already flagged `eliminated: true` are OUT of the denominator: they are
// no longer part of the answer domain, and counting them would tell the seeker the
// pending question narrows a set of size Y when the set they care about is smaller.
//
// Returns null when there is nothing meaningful to count — no shape, no
// stations at all, OR every station has already been eliminated. The last case
// used to return `{inside: 0, total: 0}` and the sheet rendered "0 of 0 active
// stations", which is worse than no readout (it looks like a real answer and
// waits to become a divide-by-zero the moment a caller ever percentages it).
// Distinguishing "no counter to show" from "the counter is zero" is the
// caller's job now — layers.js reads null and hides the readout row instead of
// rendering a meaningless number.
export function countStationsInEliminated(eliminated, stations) {
  if (!eliminated || !Array.isArray(stations) || !stations.length) return null;
  if (typeof window === "undefined" || !window.turf) return null;
  const turf = window.turf;
  let shape;
  try { shape = eliminated.type === "Feature" ? eliminated : turf.feature(eliminated); }
  catch (_) { return null; }
  let inside = 0, total = 0;
  for (const s of stations) {
    if (s.eliminated) continue;
    total++;
    try {
      if (turf.booleanPointInPolygon(turf.point([s.lng, s.lat]), shape)) inside++;
    } catch (_) { /* skip a station whose containment can't be computed */ }
  }
  if (total === 0) return null;
  return { inside, total };
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
