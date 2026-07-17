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
// §F4's nearestLine), drawn BELOW the mask so track outside the play area fades under the
// shading instead of competing with it, and one stroke PER WAY — never per line — so track
// shared by six services isn't stacked six deep.
//
// §G1 said "one bold UNIFORM stroke". Deviated: strokes are coloured by transport MODE. The
// doc's reasoning was about not stacking per-line strokes, which still holds — this is still
// one stroke per physical way. But modes are now user-visible and individually switchable, so
// a mode's colour is what makes the filter legible on the map instead of a guess.
import * as db from "./db.js";
import * as store from "./store.js";
import { toast, openSheet, escapeHtml } from "./ui.js";

// Rail geometry changes on the timescale of construction projects, so a long TTL. This is a
// refresh horizon, not an expiry: a stale entry is still served when the network fails (see
// loadLines) because a month-old rail line beats a blank map on a board with no signal.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

// zIndex 0 puts these under MASK_BASE (1) in layers.js, so track outside the play area reads
// as dimmed rather than being erased or drawn over the shading.
const BASE = { clickable: false, zIndex: 0, strokeOpacity: 0.9, strokeWeight: 3 };

// Transport modes, in the order a player thinks about them. Every one is switchable: a tram
// IS a valid way to travel, so which modes count is the player's call about their board, not
// something to decide for them by dropping a tag from the query.
export const ROUTE_MODES = [
  { route: "subway", label: "Metro / subway", colour: "#38bdf8" },
  { route: "light_rail", label: "Light rail / S-Bahn", colour: "#22d3ee" },
  { route: "train", label: "Train / suburban rail", colour: "#f472b6" },
  { route: "tram", label: "Tram", colour: "#facc15" },
  { route: "monorail", label: "Monorail", colour: "#c084fc" },
];
const MODE_COLOUR = Object.fromEntries(ROUTE_MODES.map((m) => [m.route, m.colour]));
const MODE_LABEL = Object.fromEntries(ROUTE_MODES.map((m) => [m.route, m.label]));
const FALLBACK_COLOUR = "#94a3b8";

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
    const id = l.ref || baseLineName(l.name);
    if (!id) continue;
    // The ROUTE is part of the identity, not just a label. `ref` is only unique within a
    // mode: Milan has tram 1 and metro M1, Paris has Métro 1 and tram T1. Keying on ref
    // alone would silently weld a tram and a metro into one "line" whose geometry is two
    // unrelated things — and the user would then have no way to hide one without the other,
    // which is the whole point of the filter.
    const key = `${l.route || "?"}:${id}`;
    let g = groups.get(key);
    if (!g) { g = { key, id, ref: l.ref || null, route: l.route || null, names: [], wayIds: new Set() }; groups.set(key, g); }
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
    out.push({ key: g.key, ref: g.ref, route: g.route, label: pickLabel(g), wayIds, paths });
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

// Bump whenever the /overpass/lines payload SHAPE changes. Without this the key is just
// kind+level+bbox, so a deploy that changes the shape keeps serving 30-day-cached entries in
// the OLD shape to new code — and the failure is silent, because the JSON still parses and
// the lines still draw. Adding `route` per line did exactly that: cached entries had no
// route, so group keys came out "?:1" instead of "subway:1", and the rail filter matched
// nothing while appearing to work. A version in the key makes a shape change a cache miss.
//   v1 — {name, ref, wayIds}
//   v2 — adds `route` per line (mode filtering without a refetch)
export const PAYLOAD_VERSION = 2;
export const cacheKey = (kind, bbox, level) => `v${PAYLOAD_VERSION}:${kind}:${level ?? "-"}:${bbox}`;

// Old-version entries are dead weight (~100 KB each) that nothing will ever read again. Prune
// once per session, best-effort: a cache that can't be tidied is not a reason to fail a load,
// and dbImpl in tests need not implement the iteration methods.
let pruned = false;
async function pruneOldPayloads(dbImpl) {
  if (pruned || typeof dbImpl.getAll !== "function" || typeof dbImpl.del !== "function") return;
  pruned = true;
  try {
    for (const e of await dbImpl.getAll("lines")) {
      if (!String(e?.key).startsWith(`v${PAYLOAD_VERSION}:`)) await dbImpl.del("lines", e.key);
    }
  } catch { /* best effort — never block a load on housekeeping */ }
}

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
  try {
    await pruneOldPayloads(dbImpl);
    cached = await dbImpl.get("lines", key);
  } catch { /* IndexedDB unavailable — network only */ }

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

// Candidate lines for a Tentacles card: the lines of `kind` within `radius` of the seeker,
// grouped into what a player would name, MINUS anything hidden by the board's rail filter.
// Returns { lines, hidden } — `hidden` counts what the filter removed, so the caller can say
// so rather than silently offering a short list.
//
// The filter is honoured on purpose: "we're only playing on some metro lines" is a statement
// about the board, and a card that offers a line nobody is playing on asks the hider a
// question they cannot answer. But it must be VISIBLE — a filter silently changing which
// eliminations are possible is exactly the quiet-wrongness §A exists to remove.
//
// Fetched for the whole BOARD, then filtered to the seeker's reach — not fetched for the
// reach disc. A line inside the reach carries geometry that runs off across the board, and
// its Voronoi cell depends on where that geometry actually goes; querying only the disc would
// truncate it and bend the cell.
export async function candidateLines(kind, gameArea, center, radius, { game = null } = {}) {
  const bbox = boardBbox(gameArea);
  if (!bbox) return { lines: [], hidden: 0 };
  const proxyBase = window.JLTG_CONFIG?.OVERPASS_PROXY_URL || null;
  const data = await loadLines(kind, bbox, { proxyBase });
  const grouped = groupIntoLines(data);

  const turf = window.turf;
  const from = turf.point([center.lng, center.lat]);
  const within = [];
  for (const l of grouped) {
    // The card asks about lines "within R of me", so a line is a candidate iff any part of it
    // comes within R — measured to the LINE, not to a station on it.
    let best = Infinity;
    for (const p of l.paths) {
      const d = turf.pointToLineDistance(from, turf.lineString(p.map(([lat, lng]) => [lng, lat])), { units: "meters" });
      if (d < best) best = d;
    }
    if (best <= radius) within.push({ ...l, distance: best });
  }

  const filter = railFilter(game || store.getCurrent());
  const lines = within.filter((l) => isLineVisible(l, filter));
  lines.sort((a, b) => a.distance - b.distance);
  return { lines, hidden: within.length - lines.length };
}

// Every way of `kind` across the board, as ONE MultiLineString — the reference line for a
// Measuring card ("how far are you from the coastline?").
//
// Deliberately not grouped, unlike candidateLines: that card asks the seeker to CHOOSE between
// lines, so the lines must be separable. This one asks distance to the feature as a whole —
// there is nothing to choose between, and a coastline has no meaningful "lines" to group into
// anyway. The rail filter is not applied for the same reason: it answers "which lines are we
// playing on", which is not a question about where the coast is.
//
// Returns null when the board yields no geometry, which is a real answer, not a failure:
// `border&level=2` over Mumbai correctly returns zero (no international border crosses it).
// The caller must tell that apart from an outage — hence null vs throw.
export async function lineGeometry(kind, gameArea, { level = null } = {}) {
  const bbox = boardBbox(gameArea);
  if (!bbox) return null;
  const proxyBase = window.JLTG_CONFIG?.OVERPASS_PROXY_URL || null;
  const data = await loadLines(kind, bbox, { level, proxyBase });
  const coordinates = [];
  for (const coords of Object.values(data.ways || {})) {
    if (Array.isArray(coords) && coords.length >= 2) coordinates.push(coords.map(([lat, lng]) => [lng, lat]));
  }
  if (!coordinates.length) return null;
  return {
    geometry: { type: "MultiLineString", coordinates },
    from: data.from,
    counts: data.counts,
  };
}

// The game's rail filter, defaulted. Stored as what's HIDDEN so anything new — a mode this
// board didn't have, a line that opens later — is visible by default rather than missing
// because an older game never listed it.
export function railFilter(game) {
  return {
    hiddenRoutes: new Set(game?.railFilter?.hiddenRoutes || []),
    hiddenLines: new Set(game?.railFilter?.hiddenLines || []),
  };
}
export function isLineVisible(line, filter) {
  return !filter.hiddenRoutes.has(line.route) && !filter.hiddenLines.has(line.key);
}

export class Lines {
  constructor(map) {
    this.map = map;
    this.overlays = [];
    this.data = null;      // the raw /overpass/lines payload for this board
    this.loading = false;
  }

  // "On" means something is actually drawn. Hiding every mode IS off — there is no separate
  // master switch to get out of sync with the filter.
  isOn() { return this.overlays.length > 0; }

  // Fetch once per board, then filter locally. The fetch is slow and fails ~64% of the time,
  // so re-querying on every checkbox would make the filter unusable; the payload carries the
  // route type per line precisely so it doesn't have to.
  async load(gameArea) {
    if (this.data) return this.data;
    if (!gameArea) { toast("Draw a game area first — lines are fetched for the board."); return null; }
    const bbox = boardBbox(gameArea);
    if (!bbox) { toast("The game area is too small or malformed to fetch lines for."); return null; }
    this.loading = true;
    try {
      toast("Loading rail lines…");
      const proxyBase = window.JLTG_CONFIG?.OVERPASS_PROXY_URL || null;
      this.data = await loadLines("rail", bbox, { proxyBase });
      if (this.data.from === "cache-stale") toast("Showing an offline copy of the rail lines.");
      return this.data;
    } catch (err) {
      console.warn("lines load failed", err);
      // 400 is our request being wrong; anything else is the endpoint being busy. Collapsing
      // them is how an outage gets mistaken for a code bug.
      toast(err.status === 400 ? `Rail request rejected: ${err.message}` : `Couldn't load rail lines — ${err.message}`);
      return null;
    } finally {
      this.loading = false;
    }
  }

  lineGroups() { return this.data ? groupIntoLines(this.data) : []; }

  // Draw each WAY once — not each line. A way shared by six services is one physical track,
  // and drawing per-line would stack six strokes on the same rails (§G1 CORRECTION 2). Colour
  // comes from the mode so the filter is legible on the map.
  render() {
    this._clearOverlays();
    if (!this.data) return;
    const filter = railFilter(store.getCurrent());
    const visible = this.lineGroups().filter((l) => isLineVisible(l, filter));

    // A way can belong to several lines. Visible wins: if any line showing it is on, the
    // track is on the map, drawn once, in that line's mode colour.
    const wayMode = new Map();
    for (const l of visible) for (const id of l.wayIds) if (!wayMode.has(id)) wayMode.set(id, l.route);

    for (const [id, route] of wayMode) {
      const coords = this.data.ways?.[id];
      if (!coords || coords.length < 2) continue;
      this.overlays.push(new google.maps.Polyline({
        ...BASE,
        strokeColor: MODE_COLOUR[route] || FALLBACK_COLOUR,
        path: coords.map(([lat, lng]) => ({ lat, lng })),
        map: this.map,
      }));
    }
  }

  _setFilter(mutate) {
    store.update((g) => {
      if (!g.railFilter) g.railFilter = { hiddenRoutes: [], hiddenLines: [] };
      mutate(g.railFilter);
    });
    store.saveNow(); // the filter is a decision about the board; a quick close shouldn't lose it
    this.render();
  }

  async openPanel(gameArea) {
    if (this.loading) return;
    if (!this.data && !(await this.load(gameArea))) return;

    const groups = this.lineGroups();
    if (!groups.length) return toast("No rail lines found on this board.");
    // Draw before the sheet opens, so the map behind it already shows what the filter is
    // talking about. The sheet is mapInteractive, so both are visible at once.
    this.render();

    const filter = railFilter(store.getCurrent());
    // Only offer modes this board actually has — a Tram checkbox on a board with no trams is
    // noise, and worse, it implies trams exist here and are hidden.
    const present = ROUTE_MODES.filter((m) => groups.some((l) => l.route === m.route));
    const other = groups.filter((l) => !MODE_LABEL[l.route]);

    const modeRow = (m) => {
      const lines = groups.filter((l) => l.route === m.route);
      const shown = lines.filter((l) => isLineVisible(l, filter)).length;
      const on = !filter.hiddenRoutes.has(m.route);
      return `
        <div class="mode-block">
          <label class="mode-head">
            <input type="checkbox" class="rf-mode" data-route="${m.route}" ${on ? "checked" : ""}/>
            <span class="line-dot" style="background:${m.colour}"></span>
            <strong>${escapeHtml(m.label)}</strong>
            <span class="muted rf-count" data-route="${m.route}">· ${shown}/${lines.length} shown</span>
          </label>
          <div class="mode-lines" ${on ? "" : 'style="opacity:.45"'}>
            ${lines.map((l) => `
              <label><input type="checkbox" class="rf-line" data-key="${escapeHtml(l.key)}"
                ${filter.hiddenLines.has(l.key) ? "" : "checked"} ${on ? "" : "disabled"}/>
                ${escapeHtml(l.label)}</label>`).join("")}
          </div>
        </div>`;
    };

    const s = openSheet({
      title: "Rail lines",
      mapInteractive: true,
      bodyHTML: `
        <p class="muted">Real rail geometry from OpenStreetMap — including the suburban locals Google's transit layer omits. Turn off whatever isn't in play on this board; it's remembered per game.</p>
        ${present.map(modeRow).join("")}
        ${other.length ? `<div class="mode-block"><label class="mode-head"><span class="line-dot" style="background:${FALLBACK_COLOUR}"></span><strong>Other</strong> <span class="muted">· ${other.length}</span></label>
          <div class="mode-lines">${other.map((l) => `<label><input type="checkbox" class="rf-line" data-key="${escapeHtml(l.key)}" ${filter.hiddenLines.has(l.key) ? "" : "checked"}/> ${escapeHtml(l.label)}</label>`).join("")}</div></div>` : ""}
        <div class="row">
          <button id="rf-all" class="btn">Show all</button>
          <button id="rf-none" class="btn">Hide all</button>
        </div>
        <div class="sheet-actions"><button id="rf-done" class="btn btn-primary">Done</button></div>`,
    });

    const reopen = () => { s.close(); this.openPanel(gameArea); };
    s.q("#rf-done").onclick = () => s.close();
    s.q("#rf-all").onclick = () => { this._setFilter((f) => { f.hiddenRoutes = []; f.hiddenLines = []; }); reopen(); };
    s.q("#rf-none").onclick = () => {
      // Hide by MODE, not by listing every line: a line that appears later must not be
      // silently visible just because it wasn't around when "Hide all" was pressed.
      this._setFilter((f) => { f.hiddenRoutes = [...new Set(groups.map((l) => l.route))]; });
      reopen();
    };
    for (const el of s.qa(".rf-mode")) {
      el.onchange = () => {
        const route = el.dataset.route;
        this._setFilter((f) => {
          const set = new Set(f.hiddenRoutes);
          el.checked ? set.delete(route) : set.add(route);
          f.hiddenRoutes = [...set];
        });
        reopen(); // the per-line rows under this mode enable/disable with it
      };
    }
    for (const el of s.qa(".rf-line")) {
      el.onchange = () => {
        const key = el.dataset.key;
        this._setFilter((f) => {
          const set = new Set(f.hiddenLines);
          el.checked ? set.delete(key) : set.add(key);
          f.hiddenLines = [...set];
        });
        // Refresh the "n/m shown" counts in place. Reopening the sheet on every tick would
        // fight someone unticking several lines in a row.
        const now = railFilter(store.getCurrent());
        for (const m of present) {
          const lines = groups.filter((l) => l.route === m.route);
          const cnt = s.q(`.rf-count[data-route="${m.route}"]`);
          if (cnt) cnt.textContent = `· ${lines.filter((l) => isLineVisible(l, now)).length}/${lines.length} shown`;
        }
      };
    }
  }

  _clearOverlays() {
    this.overlays.forEach((o) => o.setMap(null));
    this.overlays = [];
  }

  // Full reset — used on game switch, where the board (and so the geometry) changes.
  clear() {
    this._clearOverlays();
    this.data = null;
  }
}
