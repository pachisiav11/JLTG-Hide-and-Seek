// Custom station lists (v2 Phase 3, item O).
//
// Parse a station set out of CSV, GeoJSON or KML. The reason this matters is not the file
// formats — it is that OSM and Google both have blind spots, and a group that has already
// agreed a station list (a shared Google MyMaps pin layer, a spreadsheet of "stops we're
// playing", a GTFS export someone converted) currently has no way to get it into the game.
// They retype it or they play with the wrong set.
//
// KML is here specifically because Google MyMaps exports it, and MyMaps is what non-technical
// players actually use to agree a board.
//
// Deliberately dependency-free and DOM-free:
//   - the CSV path is hand-rolled rather than pulling in a parser, because the dialect that
//     matters is "what a spreadsheet exports" and that is quoted fields, embedded commas and
//     CRLF — a few dozen lines, and no new dependency in a PWA that has to work offline.
//   - the KML path is a regex scan rather than DOMParser, so this module is testable under
//     `node --test` without a DOM shim and works identically in a worker.
//
// Everything returns the same shape as the rest of the station pipeline expects:
//   { id, name, lat, lng, kind }
// so an imported list is indistinguishable from a sourced one downstream.

export const IMPORT_KINDS = ["csv", "geojson", "kml"];

// A station id has to be STABLE across re-imports, or a station the seeker eliminated comes
// back to life the next time the file is loaded. Prefer whatever identity the file carries;
// fall back to the rounded coordinate, which is stable for the same file and distinct enough
// that two real stops never collide (6 dp is ~0.1 m).
function stationId(explicit, lat, lng) {
  const raw = explicit == null ? "" : String(explicit).trim();
  if (raw) return raw.startsWith("osm:") || raw.startsWith("places:") || raw.startsWith("custom:")
    ? raw
    : `custom:${raw}`;
  return `custom:${lat.toFixed(6)},${lng.toFixed(6)}`;
}

function finiteCoord(lat, lng) {
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // Out-of-range coordinates are almost always swapped lat/lng columns. Rejecting them beats
  // silently placing the board's stations off the map, which is very hard to diagnose from
  // the UI.
  if (a < -90 || a > 90 || b < -180 || b > 180) return null;
  return { lat: a, lng: b };
}

// ---- CSV ----------------------------------------------------------------

// Split one CSV line, honouring double-quoted fields and "" escapes.
function splitCsvLine(line) {
  const out = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const LAT_KEYS = ["lat", "latitude", "y", "stop_lat"];
const LNG_KEYS = ["lng", "lon", "long", "longitude", "x", "stop_lon"];
const NAME_KEYS = ["name", "title", "station", "label", "stop_name"];
const ID_KEYS = ["id", "station_id", "osm_id", "stop_id"];

function pickHeader(headers, candidates) {
  for (const c of candidates) {
    const i = headers.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
}

export function parseStationsCsv(text) {
  const lines = String(text).split(/\r\n|\n|\r/).filter((l) => l.trim().length);
  if (!lines.length) throw new Error("The CSV is empty.");

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/^﻿/, ""));
  const li = pickHeader(headers, LAT_KEYS);
  const gi = pickHeader(headers, LNG_KEYS);
  const ni = pickHeader(headers, NAME_KEYS);
  const ii = pickHeader(headers, ID_KEYS);

  // Naming the accepted spellings beats "invalid CSV": the fix is renaming one column and
  // the player cannot guess which spellings are understood.
  if (li < 0) throw new Error(`No latitude column. Accepted: ${LAT_KEYS.join(", ")}.`);
  if (gi < 0) throw new Error(`No longitude column. Accepted: ${LNG_KEYS.join(", ")}.`);

  const out = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = splitCsvLine(lines[r]);
    const coord = finiteCoord(cells[li], cells[gi]);
    if (!coord) continue; // skip the row, keep the file — one bad row must not fail an import
    const name = (ni >= 0 ? cells[ni] : "") || "";
    out.push({
      id: stationId(ii >= 0 ? cells[ii] : "", coord.lat, coord.lng),
      name: name || `Station ${out.length + 1}`,
      lat: coord.lat,
      lng: coord.lng,
      kind: "custom",
    });
  }
  return out;
}

// ---- GeoJSON ------------------------------------------------------------

export function parseStationsGeoJson(objOrText) {
  const obj = typeof objOrText === "string" ? JSON.parse(objOrText) : objOrText;
  const out = [];

  const pushPoint = (coords, props = {}) => {
    if (!Array.isArray(coords)) return;
    const coord = finiteCoord(coords[1], coords[0]); // GeoJSON is [lng, lat]
    if (!coord) return;
    const name = props["name:en"] || props.name || props.title || props.Name || "";
    const id = props.id ?? props.osm_id ?? props["@id"] ?? props.stop_id ?? "";
    out.push({
      id: stationId(id, coord.lat, coord.lng),
      name: name || `Station ${out.length + 1}`,
      lat: coord.lat,
      lng: coord.lng,
      kind: "custom",
    });
  };

  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    switch (node.type) {
      case "FeatureCollection": (node.features || []).forEach(walk); return;
      case "Feature": {
        const g = node.geometry;
        if (!g) return;
        if (g.type === "Point") pushPoint(g.coordinates, node.properties || {});
        // A MultiPoint feature is one named thing at several places — a station with
        // multiple entrances. Each becomes its own zone, which is right: they are separate
        // ground, and the hider can be at any of them.
        else if (g.type === "MultiPoint") (g.coordinates || []).forEach((c) => pushPoint(c, node.properties || {}));
        return;
      }
      case "GeometryCollection": (node.geometries || []).forEach((g) => walk({ type: "Feature", geometry: g, properties: {} })); return;
      case "Point": pushPoint(node.coordinates, {}); return;
      case "MultiPoint": (node.coordinates || []).forEach((c) => pushPoint(c, {})); return;
      default: return;
    }
  };
  walk(obj);
  return out;
}

// ---- KML ----------------------------------------------------------------

// Google MyMaps and Earth both export Placemarks with a <Point><coordinates>lng,lat[,alt].
// Non-Point placemarks (a drawn route, a region) are skipped rather than approximated —
// a route's first vertex is not a station and pretending it is would put a phantom zone on
// the board.
export function parseStationsKml(text) {
  const src = String(text);
  const out = [];
  const placemarks = src.split(/<Placemark[\s>]/i).slice(1);
  for (const pm of placemarks) {
    const point = pm.match(/<Point\b[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/Point>/i);
    if (!point) continue;
    const first = point[1].trim().split(/\s+/)[0] || "";
    const [lngRaw, latRaw] = first.split(",");
    const coord = finiteCoord(latRaw, lngRaw);
    if (!coord) continue;

    let name = "";
    const nameMatch = pm.match(/<name>([\s\S]*?)<\/name>/i);
    if (nameMatch) {
      name = nameMatch[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1") // MyMaps wraps names in CDATA
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .trim();
    }
    out.push({
      id: stationId("", coord.lat, coord.lng),
      name: name || `Station ${out.length + 1}`,
      lat: coord.lat,
      lng: coord.lng,
      kind: "custom",
    });
  }
  return out;
}

// ---- Dispatch -----------------------------------------------------------

/**
 * Sniff the format and parse. `hint` may be a filename, a MIME type, or nothing.
 *
 * Sniffing the CONTENT wins over the hint, because the hint is routinely wrong: a MyMaps
 * download served as application/octet-stream, a .txt of CSV, a GeoJSON someone saved as
 * .json. The hint only breaks ties.
 */
export function parseStations(text, hint = "") {
  const src = String(text ?? "").trim();
  if (!src) throw new Error("The file is empty.");
  const h = String(hint || "").toLowerCase();

  if (src.startsWith("{") || src.startsWith("[")) return parseStationsGeoJson(src);
  if (/^<\?xml|<kml\b|<Placemark\b/i.test(src)) return parseStationsKml(src);
  if (h.includes("json")) return parseStationsGeoJson(src);
  if (h.includes("kml") || h.includes("xml")) return parseStationsKml(src);
  return parseStationsCsv(src);
}

/**
 * Merge an imported list into an existing one.
 *
 * `mode`:
 *   "replace" — the imported list becomes the station set.
 *   "merge"   — imported stations are added to the existing set.
 *
 * De-duplicated by id first, then by rounded coordinate, so re-importing the same file twice
 * does not double every zone. Crucially, an incoming station that matches an existing one
 * does NOT overwrite it: the existing record may carry `eliminated`, and dropping that would
 * silently un-eliminate stations the seeker has already ruled out.
 */
export function mergeStations(existing, incoming, mode = "merge") {
  const base = mode === "replace" ? [] : (existing || []).slice();
  const seen = new Set();
  const key = (s) => `${Number(s.lat).toFixed(5)},${Number(s.lng).toFixed(5)}`;
  for (const s of base) { if (s?.id) seen.add(`id:${s.id}`); seen.add(key(s)); }

  let added = 0, skipped = 0;
  for (const s of incoming || []) {
    if (seen.has(`id:${s.id}`) || seen.has(key(s))) { skipped++; continue; }
    seen.add(`id:${s.id}`); seen.add(key(s));
    base.push(s);
    added++;
  }
  return { list: base, added, skipped };
}
