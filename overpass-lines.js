// Linear geometry (rail, coastline, borders) from Overpass — query building and shaping.
//
// Split from server.js for the same reason as overpass.js: this is pure data transformation
// and gets tested without starting an HTTP server. overpass.js knows how to GET a JSON answer
// out of a flaky API; this knows what to ask for and what to hand back.
//
// Why this exists: `google.maps.TransitLayer` is raster tiles from Google's own feed
// inventory — no knob to add an agency, restyle, filter or query it (§G0). Mumbai's Metro
// draws and the suburban locals don't, and no amount of Google API work changes that. So the
// lines come from OSM.

// ---- What counts as a line -------------------------------------------------------------
//
// NOT `way["railway"="rail"]`: that is every siding, yard, spur and freight stub — thousands
// of segments, none of them a line anyone rides. Route RELATIONS are curated passenger
// services and they carry names.
//
// FLAGGED, not settled: `tram` is in this set because §G1 specifies it, but trams run on
// streets and the brief was "everything except streets". It also dominates dense boards —
// Berlin returns 5477 ways to Mumbai's 806, largely tram. That's a game-design call, so it's
// left visible here rather than quietly dropped.
export const RAIL_ROUTE_TYPES = ["train", "subway", "light_rail", "tram", "monorail"];

// What the "Metro Lines" card means, which is NOT the same set. Measured across 8 cities
// (2026-07-16): `route=train` is intercity and suburban rail — in DC and New York the single
// biggest group is 60+ relations of "Amtrak Northeast Regional", which nobody would call a
// metro line; `route=tram` is street trams. Both are noise on this card.
//
// Excluding `train` also dodges a real trap. On mainline networks `ref` is sometimes the
// OPERATOR, not the line: Tokyo's `KS` merges 京成本線 and 押上線, and Paris's `H` merges 32
// Transilien services. Grouping those by ref produces one giant "line" that cannot
// discriminate — §F3's over-grouping failure exactly. On `route=subway` the ref IS the line in
// all 8 cities, so the card stays on the tags where the assumption actually holds.
//
// light_rail and monorail are IN deliberately: Berlin's S-Bahn, London's DLR, Singapore's LRT
// and the Mumbai Monorail all read as "metro" to a player. The cost is small noise (DC's
// light_rail includes the Capitol people-movers).
export const METRO_ROUTE_TYPES = ["subway", "light_rail", "monorail"];

// OSM admin_level for borders. Measured across 14 countries × 3 cities (2026-07-15):
// level 4 is the first-order division in 14/14 — the one level that is safe to hardcode.
// The SECOND-order division has no fixed level and varies WITHIN countries (Germany is
// mostly 5, but Berlin jumps 4→9; France and the UK use 5 or 6), so there is deliberately
// no "second division" option here: a per-country lookup table cannot express it.
export const BORDER_LEVELS = { country: 2, division: 4 };
export const DEFAULT_BORDER_LEVEL = BORDER_LEVELS.division;

// 5 decimal places ≈ 1.1 m — well inside hand-tracing error, and it is most of what makes a
// dense board viable (raw Overpass coords carry ~7dp of noise nobody can see).
const r5 = (n) => Math.round(n * 1e5) / 1e5;

export function bboxIsValid(bbox) {
  const p = String(bbox || "").split(",").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return false;
  const [s, w, n, e] = p;
  return s >= -90 && n <= 90 && s < n && w >= -180 && e <= 180 && w < e;
}

// ---- Queries ---------------------------------------------------------------------------
//
// Two-part output for rail/border:
//   `.r out body;`             relation tags + member way IDS, no geometry. Cheap, and the
//                              only way to learn which line a way belongs to — `out geom` on
//                              a way carries the WAY's tags, never the parent relation's name.
//   `way(r.r)(BBOX); out geom;` the geometry, clipped, de-duplicated by Overpass's set
//                              semantics (a way shared by six relations appears once).
//
// `way(r.r)` and NOT `way(r)`: `->.r` stores the relations in the named set `.r`, but `way(r)`
// recurses from the DEFAULT set `_`, which is then empty — measured, it returns 0 ways in
// Mumbai AND Berlin while HTTP 200 and valid JSON make it look fine. Naming the set makes that
// bug impossible to reintroduce.
//
// The (BBOX) on the way step is load-bearing, not an optimisation. Unclipped, Berlin is 34 MB
// at 33.9 s and London 37 MB at 32.9 s against a 45 s fetch timeout. Measured lossless: it
// keeps every way a client-side clip would keep and returns each one WHOLE, so lines do not
// truncate at the board edge.
//
// Rejected alternative: `out geom(BBOX)` on the relations puts names and clipped geometry in
// one pass with no join — but it emits every member ref anyway AND repeats shared way geometry
// once per relation (Berlin: 19 720 member-geoms for 5 605 unique ways). Measured 10.5 MB vs
// this 8.5 MB, and it loses the de-duplication the render depends on.
function routeQuery(bbox, routeTypes) {
  const routes = routeTypes.join("|");
  return `[out:json][timeout:90];
relation["route"~"^(${routes})$"](${bbox})->.r;
.r out body;
way(r.r)(${bbox});
out geom;`;
}

// Administrative borders. Same relation→way shape as rail; the name is the region's
// ("Maharashtra"), which is what a "which side of the border" card wants to say.
function borderQuery(bbox, level) {
  return `[out:json][timeout:90];
relation["boundary"="administrative"]["admin_level"="${level}"](${bbox})->.r;
.r out body;
way(r.r)(${bbox});
out geom;`;
}

// Coastline is tagged directly on ways — no relation indirection, and no per-line identity to
// recover (there is one coastline; islands are just more of it). So: no `out body` step.
function coastlineQuery(bbox) {
  return `[out:json][timeout:90];
way["natural"="coastline"](${bbox});
out geom;`;
}

export function buildLinesQuery(kind, bbox, { level = DEFAULT_BORDER_LEVEL } = {}) {
  switch (kind) {
    case "rail": return routeQuery(bbox, RAIL_ROUTE_TYPES);
    case "metro": return routeQuery(bbox, METRO_ROUTE_TYPES);
    case "coastline": return coastlineQuery(bbox);
    case "border": return borderQuery(bbox, level);
    default: throw Object.assign(new Error(`Unknown line kind "${kind}".`), { badRequest: true });
  }
}

export const LINE_KINDS = ["rail", "metro", "coastline", "border"];

// ---- Shaping ---------------------------------------------------------------------------
//
// Returns { kind, lines:[{name, ref, wayIds}], ways:{id:[[lat,lng],…]}, counts }.
//
// Geometry lives ONCE in `ways`; `lines` only references it by id. This is deliberately not
// the `[{name, ref, coords}]` shape §G1 sketched, because the two consumers want different
// things and that shape only serves one:
//   - the RENDER wants each physical track drawn once with a uniform stroke. Inlining coords
//     per line repeats shared rails (Berlin: 142 329 vertices vs 46 095 unique — 3×) and
//     draws them 3.5 deep, which is exactly the blotchy overlap §G1 CORRECTION 2 warns about.
//   - §F4/§F1 want per-line grouping, which `wayIds` gives them losslessly.
// So this shape serves both at 1/3 the payload, and no consumer has to de-dupe.
export function normalizeLines(kind, json, { minCoords = 2 } = {}) {
  const elements = json?.elements || [];
  const ways = {};
  for (const el of elements) {
    if (el.type !== "way" || !Array.isArray(el.geometry)) continue;
    const coords = el.geometry.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => [r5(p.lat), r5(p.lon)]);
    if (coords.length < minCoords) continue; // a 1-point way cannot draw
    ways[el.id] = coords;
  }

  let lines;
  if (kind === "coastline") {
    // One synthetic line so every kind has the same shape; there is no per-line identity to
    // recover from OSM here, and no card asks "which coastline?".
    const ids = Object.keys(ways).map(Number);
    lines = ids.length ? [{ name: "Coastline", ref: null, route: "coastline", wayIds: ids }] : [];
  } else {
    lines = [];
    for (const el of elements) {
      if (el.type !== "relation") continue;
      const wayIds = (el.members || [])
        .filter((m) => m.type === "way" && ways[m.ref])
        .map((m) => m.ref);
      // A relation whose track is entirely outside the box contributes nothing. Dropping it
      // keeps `lines` honest: every entry has geometry a seeker can actually see.
      if (!wayIds.length) continue;
      const t = el.tags || {};
      lines.push({
        name: t.name || t["name:en"] || t.ref || `(unnamed ${kind})`,
        ref: t.ref || null,
        // The OSM route type (train/subway/tram/…). Carried so the client can show or hide a
        // whole mode without re-querying — a tram is a legitimate way to travel and the
        // player decides whether it counts, but that decision must not cost a slow, failure-
        // prone round trip. `border` has no route tag; boundary is the closest analogue.
        route: t.route || t.boundary || null,
        wayIds,
      });
    }
  }

  let vertexCount = 0;
  for (const id of Object.keys(ways)) vertexCount += ways[id].length;
  return {
    kind,
    lines,
    ways,
    counts: { lines: lines.length, ways: Object.keys(ways).length, vertices: vertexCount },
  };
}
