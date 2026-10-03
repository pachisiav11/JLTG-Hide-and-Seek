// Hand the play area to another phone as plain GeoJSON text.
//
// The board used to be shareable only inside ☰ Menu ▸ Share link, bundled with every question
// and answer — which is not what a group setting up a game wants. They want the BOUNDARY, on
// every phone, before anyone asks anything, and they want to be able to see that it arrived
// intact. Nothing in the app could export the zones on their own, even though Zones ▸ Import
// has always accepted GeoJSON.
//
// So the export format is exactly what that import box already reads: a GeoJSON
// FeatureCollection, one Polygon Feature per zone. That keeps the receiving side the existing,
// tested path (paste → Import → zones added) and makes the text useful outside the app too
// (geojson.io, Google My Maps) with no converter.
//
// Two additions over a bare FeatureCollection, both invisible to other tools:
//   - `properties.mode: "subtract"` on an excluded area. Without it an exported hole comes back
//     as an ADDED zone on the other phone — the bay is in play there and out of play here, and
//     every question the two phones answer about it then disagrees.
//   - a top-level `jltg` member (GeoJSON permits foreign members) naming what this is and
//     carrying the board's fingerprint, so a receiver can be told what they pasted.
//
// Pure: no DOM and no map. `areaFingerprint` needs no turf at all, so it can be checked in a
// node test without the vendored bundle.

export const AREA_KIND = "play-area";
export const AREA_FORMAT_VERSION = 1;

// Six decimals of a degree is ~0.11 m at the equator: far below a fingertip on a phone map, and
// the precision every coordinate in the export is written at. The fingerprint reads coordinates
// at the SAME precision, which is what makes it survive the round trip: the sender hashes
// toFixed(6) of its stored doubles, the receiver stores the parsed toFixed(6) strings, and
// toFixed(6) of those gives back the identical strings.
const DP = 6;
const fix = (n) => Number(n).toFixed(DP);

// Drop a closing vertex that repeats the first. Stored zones are open rings (`zones.js` and
// `parseZoneInput` both strip the closer), but a file from elsewhere may not be, and the
// fingerprint must not change because one copy of a ring happens to carry it.
function openRing(ring) {
  const r = (ring || []).filter((p) => Array.isArray(p) && p.length >= 2);
  if (r.length > 1) {
    const a = r[0], b = r[r.length - 1];
    if (fix(a[0]) === fix(b[0]) && fix(a[1]) === fix(b[1])) return r.slice(0, -1);
  }
  return r;
}

/**
 * The board as a GeoJSON FeatureCollection. Zones are stored [[lat, lng], …]; GeoJSON wants
 * [lng, lat] and a closed ring, so both are converted here and nowhere else.
 */
export function exportAreaGeoJSON(game) {
  const zones = Array.isArray(game?.zones) ? game.zones : [];
  const features = [];
  for (const z of zones) {
    const ring = openRing(z?.polygon);
    if (ring.length < 3) continue; // the fold skips these too — exporting one would re-import as nothing
    const coords = ring.map(([lat, lng]) => [Number(fix(lng)), Number(fix(lat))]);
    coords.push([...coords[0]]);
    const properties = { name: z.name || "" };
    // Only recorded on an exclusion, mirroring how zones store it (zones.js addZone).
    if (z.mode === "subtract") properties.mode = "subtract";
    features.push({ type: "Feature", properties, geometry: { type: "Polygon", coordinates: [coords] } });
  }
  return {
    type: "FeatureCollection",
    jltg: { kind: AREA_KIND, v: AREA_FORMAT_VERSION, name: game?.name || "", fingerprint: areaFingerprint(zones) },
    features,
  };
}

/** Compact JSON text for a chat message. Compact rather than pretty: it is pasted, not read. */
export function exportAreaText(game) {
  return JSON.stringify(exportAreaGeoJSON(game));
}

// 32-bit FNV-1a. Not cryptographic and not meant to be: this answers "did the paste arrive
// intact and are we on the same board", where an accidental collision is the only adversary.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A short code that is identical on two phones exactly when their boards are.
 *
 * Built from geometry and mode only — never names. A zone the receiver imported keeps its name,
 * but a coordinate list pasted without names arrives as "Imported zone", and the board is no
 * less the same board for that.
 *
 * ORDER-INDEPENDENT, because the board is: `assembleBoard` unions all adds and then removes all
 * subtractions, so the same zones listed in a different order are the same play area, and a
 * fingerprint that disagreed would send two players hunting a difference that is not there.
 *
 * Returns "" for a board with no usable zones, so callers can omit it rather than print a code
 * for nothing.
 */
export function areaFingerprint(zones) {
  const parts = [];
  for (const z of Array.isArray(zones) ? zones : []) {
    const ring = openRing(z?.polygon);
    if (ring.length < 3) continue;
    const mode = z?.mode === "subtract" ? "-" : "+";
    parts.push(mode + ring.map(([lat, lng]) => `${fix(lat)},${fix(lng)}`).join(";"));
  }
  if (!parts.length) return "";
  parts.sort();
  return fnv1a(parts.join("|")).toString(16).toUpperCase().padStart(8, "0").slice(0, 6);
}

/**
 * Order parsed zones so every ADDED zone is folded in before any EXCLUDED one.
 *
 * `addZone` folds the board after each zone. A paste that lists the bay first would fold a
 * board made only of a subtraction, which `assembleBoard` correctly refuses (it has no area) —
 * so the exclusion would be dropped with a "couldn't merge" toast and the receiving phone would
 * end up with the bay IN play. Adds-first makes the import's outcome independent of the order
 * the file happens to list its zones in, the same property the board itself has.
 */
export function addsBeforeSubtractions(parsed) {
  const list = Array.isArray(parsed) ? parsed : [];
  return [...list.filter((z) => z?.mode !== "subtract"), ...list.filter((z) => z?.mode === "subtract")];
}
