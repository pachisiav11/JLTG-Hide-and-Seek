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

// OSM admin_level for borders.
//
// Level 2 is the international border BY DEFINITION, so it is the one level that is safe to
// hardcode.
export const BORDER_LEVELS = { country: 2 };
export const DEFAULT_BORDER_LEVEL = 4;

// First pass at this got it backwards: deriving "the Nth division" per BOARD (a Tokyo board
// ranking its own hierarchy as [4, 7], a Sapporo board as [4, 5]) answers the wrong question.
// A Matching card asks "are you in the same 2nd division as me?", which only makes sense if
// BOTH players are comparing the same KIND of boundary. A seeker on Tokyo wards and a hider
// on a Hokkaido subprefecture are not answering one question, even though each board's own
// hierarchy is internally correct — and a hider CAN be in Hokkaido, so the level has to be
// defined there too. The real game handles this by fixing ONE level per country, even where
// it is rarely discriminating almost everywhere in it — a call worth matching here.
//
// So the level is a NATIONWIDE constant. Measured by COVERAGE: over points spread across the
// whole country, what fraction have a boundary at level L? A level is usable only at 100%.
// Two probe sets are merged (scripts/spike-country-levels.js --report): a 5×5 grid per
// country (1100 probes, for rural tiers a city sample misses) AND the major-city probes from
// spike-admin-levels.js (271 probes, for the CITY-STATES a coarse grid misses — Berlin,
// Washington DC, Brussels, Moscow). Both are needed: the grid alone wrongly credited the USA
// with a universal county level because it never landed on DC.
//
// The measurement was hardened against four ways a raw grid lies (all now handled in
// --report and mirrored in countryNameFromQuery below):
//   - MARITIME boundaries. `is_in` at a coastal point returns a level-2 "Taiwan maritime
//     boundary" / "Territorial waters of Greece" area alongside the real country. Stripped by
//     name, else Taiwan resolves to a maritime polygon and every city looks foreign.
//   - TERRITORIAL-WATER points. A coastal province's polygon extends over the sea, so an
//     offshore grid point has a level-4 area but no municipality — a false "gap" that killed
//     level 6 for Australia, Thailand, Turkey, Vietnam. A grid point counts only if it hit
//     something finer than a province (admin_level ≥ 5); a city probe always counts.
//   - BORDER STRADDLE. A grid point on the DE/NL line returns Germany's level 2 but Dutch
//     Drenthe beneath it. Dropped when a point's only level-4 area belongs to another
//     surveyed country.
//   - CITY-STATES. Berlin/Hamburg (no level 6), DC (no county), Brussels (no province),
//     Moscow/St Petersburg (federal cities), Kuala Lumpur (federal territory) each break the
//     "one level everywhere" assumption for real. They correctly DEMOTE their country: the
//     USA, Germany, Russia, Australia and the UK have no nationwide 2nd division, so that
//     card falls back to hand-drawing rather than drawing a county line a DC hider has no
//     equivalent of. This is the whole point of the redo, applied honestly.
//
// Two showcases of the method working: Japan resolves to [4, 7] — level 7 (municipality)
// covers Hokkaido too (Shintoku, a Hokkaido town, is level 7, same tier as a Tokyo ward),
// while level 5 (subprefecture) is Hokkaido-only and correctly excluded. Taiwan resolves to
// [4, 9] — level 7 (district) exists only in cities and level 8 (township) only in counties,
// so neither is universal, but level 9 (village) is, at 18/18 land points.
//
// Hong Kong and Macau nest UNDER China's level-2 polygon but run their own division systems,
// so they are keyed by their own name (see countryNameFromQuery's SAR override) rather than
// inheriting China's [4, 6]. HK is measured ([5, 6] = region, district); Macau is detected
// but under-sampled, so it has no levels entry and falls back — better than China's wrong
// levels. The Philippines has no consistent 1st division at all (Zamboanga City is outside
// any province) and is omitted. A country absent here was not measured and gets no
// auto-sourced border card — measure, don't guess.
export const COUNTRY_DIVISION_LEVELS = {
  "Argentina": [4, 5],
  "Australia": [4],       // Canberra/ACT has no level-6 area
  "Austria": [4, 6],
  "Belgium": [4, 7],      // Brussels-Capital is in no province (level 6); level 7 is universal
  "Brazil": [4, 5],
  "Canada": [4],
  "China": [4, 6],        // Beijing/Shanghai are direct municipalities: level 4 → 6, no level 5
  "Czechia": [4, 5],
  "Denmark": [4, 7],
  "Egypt": [4],           // governorates (level 4) are the finest tier OSM tags nationwide
  "Finland": [4, 7],
  "France": [4, 6],
  "Germany": [4],         // Berlin/Hamburg/Bremen city-states jump 4 → 9, no level 6
  "Greece": [4, 5],
  "Hong Kong": [5, 6],    // keyed by SAR name, not China; region (5), district (6)
  "Hungary": [4, 5],
  "India": [4, 5],
  "Indonesia": [4, 5],
  "Ireland": [5, 6],
  "Israel": [4, 5],
  "Italy": [4, 6],
  "Japan": [4, 7],        // level 7 (municipality) covers Hokkaido; level 5 is Hokkaido-only
  "Malaysia": [4],        // Kuala Lumpur (federal territory) has no district level
  "Mexico": [4, 6],
  "Netherlands": [4, 8],
  "New Zealand": [4, 6],
  "Norway": [4, 7],
  // Philippines intentionally has no entry: no level has 100% coverage even for the 1st
  // division (Zamboanga City sits outside any province).
  "Poland": [4, 6],
  "Portugal": [6, 7],
  "Russia": [4],          // Moscow/St Petersburg are federal cities: no level-6 rayon
  "Singapore": [5, 6],
  "South Africa": [4, 6],
  "South Korea": [4, 6],
  "Spain": [4, 6],
  "Sweden": [4, 7],
  "Switzerland": [4, 8],
  "Taiwan": [4, 9],       // level 9 (village) is the only sub-county tier universal in TW
  "Thailand": [4, 6],
  "Turkey": [4, 6],
  // Keys here MUST match what `is_in` actually returns for a country's level-2 name:en, not
  // the shorthand this game uses casually — "UK" and "USA" are never what OSM hands back
  // (verified live: London and Edinburgh both return "United Kingdom"). A key that doesn't
  // match is a silent miss, not an error: countryDivisionLevel returns null and the card
  // quietly falls back to hand-drawing everywhere in that country, forever.
  "United Arab Emirates": [4],
  // The United Kingdom intentionally stops at [4]: the 2nd division genuinely has no
  // nationwide-consistent level (England, Scotland, Wales and Northern Ireland diverge).
  "United Kingdom": [4],
  "United States": [4],   // Washington DC has no county (level 6)
  "Vietnam": [4, 6],
};

// Names OSM attaches to a sea polygon that `is_in` returns as a level-2 area alongside the
// real country. Stripping these is load-bearing: without it Taiwan's country resolves to
// "Taiwan maritime boundary" and no HK/city point matches its country at all.
const MARITIME_NAME = /maritime|territorial waters|exclusive economic|Küstengewässer|Festlandsockel|continental shelf|\bEEZ\b/i;

// Special administrative regions that sit under another country's level-2 boundary but run
// their own division hierarchy. Keyed by their own name so they don't inherit the parent's
// levels (China's [4, 6] is meaningless in HK, which has no level-4 province of its own).
const SAR_NAMES = new Set(["Hong Kong", "Macau", "Macao"]);

// The whole containing hierarchy (tags only — cheap). NOT filtered to level 2, because SAR
// detection needs the level-3/-4 areas too.
export function buildCountryQuery(lat, lon) {
  return `[out:json][timeout:90];
is_in(${lat},${lon})->.a;
area.a["boundary"="administrative"];
out tags;`;
}

// The key into COUNTRY_DIVISION_LEVELS for a point: its SAR name if it is in one, else its
// level-2 country name with any maritime-boundary area ignored. Null if neither resolves.
export function countryNameFromQuery(json) {
  const areas = (json?.elements || [])
    .map((e) => ({
      level: Number(e.tags?.admin_level),
      name: e.tags?.["name:en"] || e.tags?.name || null,
      border: e.tags?.border_type || (e.tags?.maritime ? "maritime" : ""),
    }))
    .filter((a) => a.name && !MARITIME_NAME.test(a.name) && !/territorial|maritime/i.test(a.border));
  const sar = areas.find((a) => SAR_NAMES.has(a.name));
  if (sar) return sar.name;
  // Shortest level-2 name is a mild guard against a stray second country area on a border.
  const country = areas.filter((a) => a.level === 2).sort((a, b) => a.name.length - b.name.length)[0];
  return country?.name || null;
}

// The FIXED level for "the Nth division" in `country` (1 = 1st division, 2 = 2nd), or null
// if `country` was not measured or has fewer than `ordinal` nationwide-consistent levels.
// Null is not a failure to recover from — it is the honest answer for the UK's 2nd division
// or the Philippines' 1st: no single level would be correct for every hider location.
export function countryDivisionLevel(country, ordinal) {
  return COUNTRY_DIVISION_LEVELS[country]?.[ordinal - 1] ?? null;
}

// 5 decimal places ≈ 1.1 m — well inside hand-tracing error, and it is most of what makes a
// dense board viable (raw Overpass coords carry ~7dp of noise nobody can see).
const r5 = (n) => Math.round(n * 1e5) / 1e5;

// Rounding to 5dp COLLAPSES vertices that were <1.1 m apart into exact duplicates, and turf is
// not tolerant of that: `pointToLineDistance` on a line with any repeated consecutive point
// throws "coordinates must contain numbers" (the zero-length segment produces an internal NaN).
//
// Measured (2026-07-17): only **4 of 282** ways on a real Berlin board carry one — but that 1%
// took down 100% of the Metro Lines card, because `candidateLines` measures every line and one
// throw escapes the lot. Worse, `layers.js` catches it and reports "Couldn't load metro lines —
// falling back to stations", so a code bug of mine read as an Overpass outage and silently put
// Berlin back on the station Voronoi that §F1 exists to remove. Exactly the confusion D3 was
// filed for, one layer up.
//
// It survived every earlier check because Mumbai, DC and the Mumbai coastline captures have
// ZERO duplicates — the bug needs a network dense enough for two mapped vertices to land within
// 1.1 m of each other.
//
// Dropped HERE, where the rounding creates them, so every consumer is handed geometry turf can
// actually read. A way that collapses below minCoords is then dropped by the existing length
// check, which is correct: it was under ~1 m long.
function dropRepeats(coords) {
  const out = [];
  for (const c of coords) {
    const prev = out[out.length - 1];
    if (prev && prev[0] === c[0] && prev[1] === c[1]) continue;
    out.push(c);
  }
  return out;
}

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

// High-speed rail, for the Measuring card. This is the ONE place `railway=rail` is right
// despite the warning at the top of this file: `highspeed=yes` is what makes it tight, and the
// combination was measured (2026-07-17) to return the real line and nothing else in **9/9**
// networks — France LGV 100 ways, Spain AVE 20, Japan Shinkansen 286, Germany ICE 54, China 21,
// Italy 2, Korea KTX 93, Taiwan THSR 13, and London's HS1 80.
//
// `railway=rail` is doing real work: it excludes `railway=construction`. Mumbai has no
// high-speed rail but four ways tagged `highspeed=yes` — the Mumbai–Ahmedabad line, still being
// built. A line you cannot ride must not answer "how far are you from the high-speed line", and
// the brief's "Mumbai should not have an advantage" cuts the other way too: nor a handicap.
//
// Rejected: a maxspeed threshold. Measured on HS1, the approach ways into St Pancras are
// tagged maxspeed=40 — a `maxspeed>=250` filter drops the whole terminus end of a real
// high-speed line, which is precisely the false-elimination class §A is about.
//
// WAY-tagged, not relation-tagged, and that distinction is the finding: relation-level
// `highspeed=yes` exists in only 2/4 of the networks first sampled (France 62, Germany 17,
// Spain 0, Japan 0), so there is no way to group these into NAMED lines worldwide. That does
// not matter here — the Measuring card asks distance to the nearest high-speed line, not which
// one, so a MultiLineString is the whole answer.
function highspeedQuery(bbox) {
  return `[out:json][timeout:90];
way["railway"="rail"]["highspeed"="yes"](${bbox});
out geom;`;
}

export function buildLinesQuery(kind, bbox, { level = DEFAULT_BORDER_LEVEL } = {}) {
  switch (kind) {
    case "rail": return routeQuery(bbox, RAIL_ROUTE_TYPES);
    case "metro": return routeQuery(bbox, METRO_ROUTE_TYPES);
    case "coastline": return coastlineQuery(bbox);
    case "highspeed": return highspeedQuery(bbox);
    case "border": return borderQuery(bbox, level);
    default: throw Object.assign(new Error(`Unknown line kind "${kind}".`), { badRequest: true });
  }
}

export const LINE_KINDS = ["rail", "metro", "coastline", "highspeed", "border"];

// Kinds tagged directly on ways: no relation indirection, and no per-line identity to recover.
// They get one synthetic line so every kind hands back the same shape.
const WAY_TAGGED = { coastline: "Coastline", highspeed: "High-speed rail" };

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
    const coords = dropRepeats(
      el.geometry.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon))
        .map((p) => [r5(p.lat), r5(p.lon)]),
    );
    if (coords.length < minCoords) continue; // a 1-point way cannot draw
    ways[el.id] = coords;
  }

  let lines;
  if (WAY_TAGGED[kind]) {
    // One synthetic line so every kind has the same shape; there is no per-line identity to
    // recover from OSM here, and no card asks "which coastline?".
    const ids = Object.keys(ways).map(Number);
    lines = ids.length ? [{ name: WAY_TAGGED[kind], ref: null, route: kind, wayIds: ids }] : [];
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
