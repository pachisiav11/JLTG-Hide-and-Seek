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
// So the level has to be a NATIONWIDE constant, not a per-board derivation. Measured
// 2026-07-19: a 5×5 grid over each of 44 countries (scripts/spike-country-levels.js, 1100
// probes), scored by COVERAGE — the fraction of in-country grid points that have a boundary
// at each level. A level only goes in this table at 100% coverage; the country is omitted
// entirely, or gets fewer than 2 ordinals, where no such level exists.
//
// Japan is the case that motivated the redo, and it resolves cleanly: level 7 (municipality)
// has 100% coverage, INCLUDING Hokkaido — Shintoku (a Hokkaido town) is level 7, same tier as
// Tokyo's wards. So [4, 7] is both nationwide-consistent AND defined for a Hokkaido hider,
// with no Hokkaido-specific rule needed. Level 5 (subprefecture) covered only 29% of the
// grid — it exists ONLY in Hokkaido — so it is correctly excluded, not chosen.
//
// Two real (non-artifact) findings, not measurement noise: the UK has no single level that
// is a 2nd division everywhere (England/Scotland/Wales/NI diverge; best measured was 59%
// coverage), and the Philippines has no consistent 1st division AT ALL — some cities
// (Zamboanga) are independent of any province. Both are deliberately short entries or
// omitted rather than populated with a guess.
//
// A country not in this table was not part of the 44 measured, and gets no auto-sourced
// border card rather than a guessed level — the same "measure, don't guess" rule as
// everything else in this file. Extending coverage means re-running the spike, not adding
// an entry from intuition.
export const COUNTRY_DIVISION_LEVELS = {
  "Argentina": [4, 5],
  "Australia": [4],
  "Austria": [4, 6],
  "Belgium": [4, 6],
  "Brazil": [4, 5],
  "Canada": [4],
  "China": [4, 5],
  "Czechia": [4, 5],
  "Denmark": [4, 7],
  "Egypt": [4],
  "Finland": [4, 7],
  "France": [4, 6],
  "Germany": [4],
  "Greece": [4, 5],
  "Hungary": [4, 5],
  "India": [4, 5],
  "Indonesia": [4],
  "Ireland": [5, 6],
  "Israel": [4, 5],
  "Italy": [4, 6],
  "Japan": [4, 7],
  "Malaysia": [4],
  "Mexico": [4, 6],
  "Netherlands": [4, 8],
  "New Zealand": [4],
  "Norway": [4, 7],
  // Philippines intentionally has no entry: no level has 100% coverage even for the 1st
  // division (Zamboanga City sits outside any province) — a country-wide consistent
  // definition genuinely does not exist, so the card falls back to hand-drawing.
  "Poland": [4, 6],
  "Portugal": [6, 7],
  "Russia": [4, 6],
  "Singapore": [5, 6],
  "South Africa": [4, 6],
  "South Korea": [4, 6],
  "Spain": [4, 6],
  "Sweden": [4, 7],
  "Switzerland": [4, 8],
  "Thailand": [4],
  "Turkey": [4],
  // Keys here MUST match what `is_in` actually returns for a country's level-2 name:en, not
  // the shorthand this game uses casually — "UK" and "USA" are never what OSM hands back
  // (verified live: London and Edinburgh both return "United Kingdom"). A key that doesn't
  // match is a silent miss, not an error: countryDivisionLevel returns null and the card
  // quietly falls back to hand-drawing everywhere in that country, forever.
  "United Arab Emirates": [4],
  // The United Kingdom intentionally stops at [4]: the 2nd division genuinely has no
  // nationwide-consistent level (England, Scotland, Wales and Northern Ireland diverge),
  // not merely unmeasured.
  "United Kingdom": [4],
  "United States": [4, 6],
  "Vietnam": [4],
};

// Cheap version of the is_in query: only the level-2 (country) area is needed to key
// COUNTRY_DIVISION_LEVELS, so this asks for just that rather than the whole hierarchy.
export function buildCountryQuery(lat, lon) {
  return `[out:json][timeout:90];
is_in(${lat},${lon})->.a;
area.a["boundary"="administrative"]["admin_level"="2"];
out tags;`;
}

export function countryNameFromQuery(json) {
  const el = (json?.elements || [])[0];
  return el?.tags?.["name:en"] || el?.tags?.name || null;
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
