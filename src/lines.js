// Rail / coastline / border geometry on the map (§G, §G1).
//
// The ask: train lines should be visible — not just metros. In Mumbai, Google's transit layer
// draws the Metro but not the suburban locals (Western / Central / Harbour), which are the
// lines that actually decide the game. That is not fixable from Google's side:
// `google.maps.TransitLayer` is raster tiles from Google's own feed inventory, it takes no
// options, and you cannot add an agency to it (§G0). So the geometry comes from OSM via the
// Overpass proxy, worldwide — no per-city bundled data, no city with an advantage.
//
// Render decisions, per §G1: no line names on the map (names ride along in the payload for
// §F4's nearestLine), one bold uniform stroke, drawn BELOW the mask so track outside the play
// area fades under the shading instead of competing with it.
import * as db from "./db.js";
import { toast } from "./ui.js";

// Rail geometry changes on the timescale of construction projects, so a long TTL. This is a
// refresh horizon, not an expiry: a stale entry is still served when the network fails (see
// loadLines) because a month-old rail line beats a blank map on a board with no signal.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

// One bold uniform stroke. zIndex 0 puts it under MASK_BASE (1) in layers.js, so track outside
// the play area reads as dimmed rather than being erased or drawn over the shading.
const LINE_STYLE = {
  rail: { strokeColor: "#f472b6", strokeOpacity: 0.9, strokeWeight: 3 },
  coastline: { strokeColor: "#22d3ee", strokeOpacity: 0.9, strokeWeight: 3 },
  border: { strokeColor: "#fbbf24", strokeOpacity: 0.9, strokeWeight: 3 },
};
const BASE = { clickable: false, zIndex: 0 };

export const LINE_KIND_LABEL = { rail: "Rail lines", metro: "Metro lines", coastline: "Coastline", border: "Borders" };

// ---- Grouping OSM route relations into the lines a player would name --------------------
//
// A route relation is not a line. OSM maps each SERVICE: Mumbai's Western Line is four
// relations (fast/slow x both directions) on the same rails; Berlin's S85 is six; DC's Red
// Line is several. Offering those as separate choices is not just noisy — they occupy
// identical track, so the partition between them is meaningless noise, and the seeker is
// asked to pick between two options that mean the same thing.
//
// `ref` is the grouping signal. Measured across 8 cities (2026-07-16), grouping `route=subway`
// by ref collapses to exactly the lines a player names: DC -> R/B/O/Y/G/S, London -> Northern/
// Central/Circle/District/…, Berlin -> U1–U9, Paris -> 1–14, Singapore -> EWL/NSL/CCL/NEL/DTL/
// TEL/JRL, NYC -> 1/2/3/4/5/B/C/D/E/F/J/L/M/Z. Coverage is good but not total (DC 6/145 and
// Mumbai 3/61 relations lack a ref), so name is the fallback.
//
// CAVEAT worth keeping in view (§F3): on `route=train`, ref is sometimes the OPERATOR, not the
// line — Tokyo's `KS` merges two real lines, Paris's `H` merges 32 Transilien services. That
// would over-group into one undiscriminating "line". It does not bite here because the metro
// kind excludes train, but this function must not be pointed at mainline rail as-is.

// "Metrorail Red Line: Shady Grove => Glenmont" -> "Metrorail Red Line"
// "Line 1 (Versova → Ghatkopar)"                -> "Line 1"
// "東京メトロ銀座線 : 浅草→渋谷"                  -> "東京メトロ銀座線"
// "Rayburn Line Northbound"                     -> "Rayburn Line"
// OSM writes the direction as a ":" or "(" suffix with no single convention, so cut at
// whichever comes first and keep the head. Falls back to the whole name if that empties it.
export function baseLineName(name) {
  const s = String(name || "");
  const cut = s.split(/[:(（]/)[0].trim();
  // Some networks put the direction in a trailing WORD instead of a punctuated suffix (DC's
  // Capitol Subway: "Rayburn Line Northbound" / "Rayburn Line Southbound"). Without this they
  // stay two choices for one line — the same duplication the punctuated cut exists to remove.
  // Anchored and whole-word, so it can only ever remove a real trailing direction.
  const undirected = cut.replace(/\s+(north|south|east|west)bound$/i, "").trim();
  return undirected || cut || s.trim();
}

// data: the /overpass/lines payload. Returns [{ key, ref, label, wayIds, paths }] where
// `paths` is that line's geometry as several polylines (an OSM line is many ways, and they
// need not join end-to-end).
export function groupIntoLines(data) {
  const groups = new Map();
  for (const l of data?.lines || []) {
    const key = l.ref || baseLineName(l.name);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) { g = { key, ref: l.ref || null, names: [], wayIds: new Set() }; groups.set(key, g); }
    g.names.push(l.name);
    // A Set, because the fast and slow services of one line share most of their track and
    // would otherwise contribute the same way several times.
    for (const id of l.wayIds || []) g.wayIds.add(id);
  }

  const out = [];
  for (const g of groups.values()) {
    const wayIds = [...g.wayIds];
    const paths = wayIds.map((id) => data.ways?.[id]).filter((c) => c && c.length >= 2);
    if (!paths.length) continue; // no geometry on this board — nothing to be nearest to
    out.push({ key: g.key, ref: g.ref, label: pickLabel(g), wayIds, paths });
  }

  // Disambiguate only where it is actually needed: "Central Line" is a better label than
  // "Central Line (C)", but two groups sharing one label is a seeker picking blind.
  const seen = new Map();
  for (const l of out) seen.set(l.label, (seen.get(l.label) || 0) + 1);
  for (const l of out) if (seen.get(l.label) > 1 && l.ref) l.label = `${l.label} (${l.ref})`;

  out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return out;
}

// The most common base name across the group's relations; shortest wins a tie. Prefer the
// name over the ref because "Northern" reads and "R" does not.
function pickLabel(g) {
  const counts = new Map();
  for (const n of g.names) {
    const b = baseLineName(n);
    if (b) counts.set(b, (counts.get(b) || 0) + 1);
  }
  let best = null, bestN = -1;
  for (const [b, n] of counts) {
    if (n > bestN || (n === bestN && b.length < best.length)) { best = b; bestN = n; }
  }
  return best || g.ref || g.key;
}

// The board bbox, padded and snapped.
//
// Padded because a line that stops dead on the board edge looks like missing data; the extra
// margin runs under the mask and reads as the line continuing off-board, which it does.
//
// Snapped to 3dp (~110 m) so the SAME board produces a byte-identical cache key across
// sessions. Unsnapped, float noise in the stored polygon would miss the cache every time and
// re-fetch a slow, failure-prone query for geometry we already had.
export function boardBbox(gameArea, padFrac = 0.1) {
  const turf = window.turf;
  if (!gameArea || !turf) return null;
  const bb = turf.bbox(turf.feature(gameArea)); // [minX,minY,maxX,maxY] = [W,S,E,N]
  const padX = (bb[2] - bb[0]) * padFrac, padY = (bb[3] - bb[1]) * padFrac;
  const r3 = (n) => Math.round(n * 1e3) / 1e3;
  const s = r3(Math.max(-90, bb[1] - padY)), w = r3(Math.max(-180, bb[0] - padX));
  const n = r3(Math.min(90, bb[3] + padY)), e = r3(Math.min(180, bb[2] + padX));
  if (!(s < n && w < e)) return null; // a degenerate board would fetch the whole planet
  return `${s},${w},${n},${e}`;
}

const cacheKey = (kind, bbox, level) => `${kind}:${level ?? "-"}:${bbox}`;

async function fetchFromProxy(proxyBase, kind, bbox, level) {
  const url = new URL(proxyBase.replace(/\/+$/, "") + "/overpass/lines");
  url.searchParams.set("kind", kind);
  url.searchParams.set("bbox", bbox);
  if (level != null) url.searchParams.set("level", String(level));
  const resp = await fetch(url.toString());
  if (!resp.ok) {
    // The proxy already separates these: 400 = our query is wrong (never retry, it fails
    // identically everywhere), 502 = every Overpass endpoint was busy (transient, retry later).
    // Collapsing them into one message is how an outage gets mistaken for a code bug.
    let detail = "";
    try { detail = (await resp.json())?.error || ""; } catch { /* non-JSON body */ }
    throw Object.assign(new Error(detail || `Lines proxy HTTP ${resp.status}`), { status: resp.status });
  }
  return resp.json();
}

// Cache-first, then network, then STALE cache. The last step is the interesting one: a board is
// played outdoors, and a month-old rail line is worth far more than an empty map when Overpass
// is busy (~64% of individual calls fail) or there's no signal.
//
// `dbImpl` is injectable for the same reason overpass.js takes `fetchImpl`: it makes the
// cache ladder testable without an IndexedDB.
export async function loadLines(kind, bbox, { level = null, proxyBase = null, now = Date.now(), dbImpl = db } = {}) {
  const key = cacheKey(kind, bbox, level);
  let cached = null;
  try { cached = await dbImpl.get("lines", key); } catch { /* IndexedDB unavailable — network only */ }

  if (cached && now - cached.fetchedAt < TTL_MS) return { ...cached.data, from: "cache" };
  if (!proxyBase) {
    if (cached) return { ...cached.data, from: "cache-stale" };
    throw new Error("No Overpass proxy configured (set OVERPASS_PROXY_URL in config.js).");
  }

  try {
    const data = await fetchFromProxy(proxyBase, kind, bbox, level);
    try { await dbImpl.put("lines", { key, kind, bbox, level, fetchedAt: now, data }); } catch { /* over quota — still usable this session */ }
    return { ...data, from: "network" };
  } catch (err) {
    if (cached) return { ...cached.data, from: "cache-stale", error: err.message };
    throw err;
  }
}

export class Lines {
  constructor(map) {
    this.map = map;
    this.overlays = [];
    this.kind = null;      // which kind is currently shown, null = off
    this.loading = false;
  }

  isOn() { return this.kind != null; }

  // Toggle a kind on; toggling the SAME kind again turns it off. Returns the new on/off state
  // for the toolbar's active class.
  async toggle(kind, gameArea, { level = null } = {}) {
    if (this.kind === kind) { this.clear(); toast(`${LINE_KIND_LABEL[kind]} off`); return false; }
    if (this.loading) return this.isOn();
    if (!gameArea) { toast("Draw a game area first — lines are fetched for the board."); return this.isOn(); }

    const bbox = boardBbox(gameArea);
    if (!bbox) { toast("The game area is too small or malformed to fetch lines for."); return this.isOn(); }

    this.loading = true;
    try {
      const proxyBase = window.JLTG_CONFIG?.OVERPASS_PROXY_URL || null;
      toast(`Loading ${LINE_KIND_LABEL[kind].toLowerCase()}…`);
      const data = await loadLines(kind, bbox, { level, proxyBase });
      this.clear();
      this.kind = kind;
      this._draw(kind, data);

      // Say what actually happened. "0 lines" from a valid answer means this board genuinely
      // has none — different from an outage, and the seeker should be able to tell.
      const n = data.counts?.ways || 0;
      if (!n) toast(`No ${LINE_KIND_LABEL[kind].toLowerCase()} found on this board.`);
      else if (data.from === "cache-stale") toast(`${LINE_KIND_LABEL[kind]}: ${data.counts.lines} lines (offline copy).`);
      else toast(`${LINE_KIND_LABEL[kind]}: ${data.counts.lines} lines, ${n} segments.`);
      return true;
    } catch (err) {
      console.warn("lines load failed", err);
      toast(err.status === 400 ? `Lines request rejected: ${err.message}` : `Couldn't load ${LINE_KIND_LABEL[kind].toLowerCase()} — Overpass was busy. Try again.`);
      return this.isOn();
    } finally {
      this.loading = false;
    }
  }

  // Draw each WAY once. Not each line: a way shared by six route relations is one physical
  // track, and drawing it per-line would stack six strokes on the same rails (§G1 CORRECTION 2).
  // The payload is shaped for exactly this — geometry lives once in `ways`.
  _draw(kind, data) {
    const style = { ...BASE, ...(LINE_STYLE[kind] || LINE_STYLE.rail) };
    for (const coords of Object.values(data.ways || {})) {
      if (!coords || coords.length < 2) continue;
      this.overlays.push(new google.maps.Polyline({
        ...style,
        path: coords.map(([lat, lng]) => ({ lat, lng })),
        map: this.map,
      }));
    }
  }

  clear() {
    this.overlays.forEach((o) => o.setMap(null));
    this.overlays = [];
    this.kind = null;
  }
}
