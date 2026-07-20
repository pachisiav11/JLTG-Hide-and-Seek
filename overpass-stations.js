// Station geometry from Overpass — query building and shaping.
//
// Parallel to overpass-lines.js: split from server.js for the same reason (pure data
// transformation, tested without an HTTP server). Lines carry track; stations are the
// points a player names when a question narrows to one of them. A game-owned locked
// station set (PLAYTEST_IDEAS §0, cross-cutting) is the shared prerequisite for the
// "eliminate this station" / "eliminate this line's stations" / "eliminate a range"
// actions the playtest wanted and the board never delivered.
//
// OSM tagging is noisy — a single physical station can be a `railway=station` node, a
// `public_transport=stop_position` on each platform, a `railway=halt` for smaller stops,
// AND a `public_transport=station` relation grouping them. The playtest question is "is
// the hider at Devipada?", not "which of the six OSM nodes tagging Devipada" — so the
// output is one entry per named place, coordinates snapped, de-duplicated near-by.

import { bboxIsValid } from "./overpass-lines.js";

export { bboxIsValid };

// What counts as a station. `railway=station` covers heavy rail + metro + tram
// termini; `railway=halt` catches the smaller suburban stops (Mumbai's Devipada is a
// `halt`, not a `station`, and the playtest ended AT Devipada — so halts are load-
// bearing here, not a bonus). `public_transport=station` catches modern additions
// tagged only in the PT scheme.
//
// Deliberately NOT included: `railway=tram_stop` (a stop on a street, not a station a
// hider names) and `public_transport=stop_position` (per-platform tags that would
// balloon one station into six near-identical entries). If a board actually wants
// trams the rail filter still governs; A3-style manual add-a-station covers gaps.
export function buildStationsQuery(bbox) {
  return `[out:json][timeout:60];
(
  node["railway"="station"](${bbox});
  node["railway"="halt"](${bbox});
  node["public_transport"="station"](${bbox});
);
out tags;`;
}

// 5dp = ~1.1 m — well under the noise between different taggings of one station.
const r5 = (n) => Math.round(n * 1e5) / 1e5;

// Nearby-duplicate threshold. Two stations tagged 30 m apart on either end of one
// platform are one station; two stations 200 m apart on separate lines are not. 50 m
// picks the boundary the playtest cares about (Devipada's node and halt tags land
// within 20 m of each other in OSM). Comparison uses the equirectangular projection
// (lat/lng scale is not uniform), so at Mumbai's latitude 50 m ≈ 0.00045°.
const DEDUP_METRES = 50;

function metresBetween(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const lat0 = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180 * Math.cos(lat0);
  return R * Math.hypot(dLat, dLng);
}

// Elements → [{id, name, lat, lng, kind}]. `id` is `osm:node/<id>`, stable across
// refetches so a station the seeker eliminated stays eliminated when the set is
// re-materialised (the whole point of "locked" ids). `kind` is the raw OSM tag so a
// downstream filter can prefer stations to halts if it wants.
export function normalizeStations(json) {
  const els = json?.elements || [];
  const out = [];
  for (const el of els) {
    if (el.type !== "node") continue;
    if (!Number.isFinite(el.lat) || !Number.isFinite(el.lon)) continue;
    const t = el.tags || {};
    // A station with no name is a station a player cannot name. That is exactly the
    // "which station is it?" question the app cannot answer, so drop the entry now
    // rather than surface a "(unnamed)" row nobody can use.
    const name = t.name || t["name:en"] || null;
    if (!name) continue;
    const kind = t.railway === "halt" ? "halt"
      : t.railway === "station" ? "station"
      : t["public_transport"] === "station" ? "pt-station"
      : "other";
    out.push({
      id: `osm:node/${el.id}`,
      name,
      lat: r5(el.lat),
      lng: r5(el.lon),
      kind,
    });
  }

  // Deduplicate near-by same-name entries. OSM often carries the same station as both
  // `railway=station` and `public_transport=station` at slightly different coords —
  // keeping both means the "at station X" question has two answers, which is exactly
  // the silent wrongness this module exists to avoid.
  //
  // Prefer `station` over `halt` over `pt-station` over `other`: `station` is the tag
  // the OSM community treats as canonical and the one every downstream tool reads.
  const rank = { station: 3, halt: 2, "pt-station": 1, other: 0 };
  out.sort((a, b) => (rank[b.kind] ?? 0) - (rank[a.kind] ?? 0));
  const kept = [];
  for (const s of out) {
    const dup = kept.find((k) => k.name === s.name && metresBetween(k, s) < DEDUP_METRES);
    if (dup) continue;
    kept.push(s);
  }
  kept.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { stations: kept, counts: { raw: els.length, kept: kept.length } };
}
