// Station sourcing and line membership.
//
// This module used to serve a LOCKED STATION SET: a board-wide collection materialised
// before play and treated as the authoritative station domain for the rest of the game. That
// went in the station-list review — it asked a seeker to load several hundred stations on
// turn one, for a tool that earns its keep at the END of a game with six candidates left.
//
// What remains has two distinct users, and they no longer share a list:
//
//   * Station's Line (layers.js) sources stations PER QUESTION and confirms them with the
//     seeker. `loadStationsFromOsm` / `loadStationsFromPlaces` fetch, and
//     `stationsOnLineWithLabels` decides which sit on the chosen line. Nothing persists.
//   * The Stations panel (games.js) is now a hand-built shortlist: `makeManualStation` for a
//     tapped point, `toggleStationElimination` for striking one off.
//
// Ids stay stable across refetches (`osm:node/<id>`, `places:<place_id>`) because the
// per-question cache is keyed on them and a confirm list should not shuffle under a seeker.

import * as db from "./db.js";
import { dedupe, withProxyFailover } from "./net.js";

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
    // v2 Phase 4 (items P + R) — see the matching block in lines.js. Station sets are the
    // most-shared payload on a board (every station-relative question wants the same one),
    // so this is where de-duplication earns the most.
    const data = await dedupe(`stations:${key}`, () =>
      withProxyFailover(proxyBase, (base) => fetchFromProxy(base, bbox)));
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
// Which stations sit on `chosenLine`, each tagged with EVERY candidate line it serves.
//
// Pure, so the membership rules are unit-testable without a browser, a network or a map —
// which matters more than usual here: this is what decides which ground a "same line" answer
// keeps, and it is built from two heuristics (a distance tolerance to the way, and whatever
// OSM happened to tag) rather than from an authoritative route relation.
//
// The per-station line list is the reason this returns objects rather than ids. An
// interchange is exactly the station a seeker second-guesses on the confirm step, and
// "Dadar — also Central Line" answers that where a bare name does not.
export function stationsOnLineWithLabels(stations, chosenLine, allLines = [], { toleranceM } = {}) {
  const opts = toleranceM ? { toleranceM } : {};
  const onChosen = stationsWithinLine(stations || [], chosenLine?.paths || [], opts);
  if (!onChosen.size) return [];

  // Membership against every line, not just the chosen one. Computed once per line rather
  // than per station: stationsWithinLine already walks the whole list.
  const labelsFor = new Map();
  for (const l of allLines || []) {
    if (!l?.label) continue;
    for (const id of stationsWithinLine(stations || [], l.paths || [], opts)) {
      if (!labelsFor.has(id)) labelsFor.set(id, []);
      if (!labelsFor.get(id).includes(l.label)) labelsFor.get(id).push(l.label);
    }
  }

  return (stations || [])
    .filter((st) => onChosen.has(st.id))
    .map((st) => ({
      id: st.id, name: st.name, lat: st.lat, lng: st.lng,
      // Falling back to the chosen line keeps the shape honest when `allLines` was not
      // supplied — the station IS on it, that is why it is in this list.
      lines: labelsFor.get(st.id) || (chosenLine?.label ? [chosenLine.label] : []),
    }));
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

// "Add stations (tap map)": a manually-placed station pin, no network source and no
// name prompt. The old "Select on map" snapped the tap to the NEAREST already-known
// station — which broke exactly when OSM/Places hadn't surfaced the real station in
// the first place, the one case the button exists for. This just drops a pin at the
// exact tapped point. `seq` (the station's 1-based position in the list once added)
// names it "Station N" purely so the panel has something to show — it is not a real
// stop name and nothing downstream (line/range elimination, counters) reads it as one.
export function makeManualStation(point, seq) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  return {
    id: `manual:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    name: `Station ${seq}`,
    lat: point.lat,
    lng: point.lng,
    kind: "manual",
  };
}

