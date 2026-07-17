// The Jet Lag: The Game question bank, as data that drives the question tools.
// Source of truth: docs/jetlag_questions.md. Each tool exposes ONLY these items.
//
// `type` is a Google Places (nearbySearch) place type used to source the feature
// points automatically. `radius` (metres) is the fixed tentacle range per card.
// `approx` notes when the automatic source is a proxy for the real feature.

// ---- Tentacles ----------------------------------------------------------
// Fixed-radius "of these, which are you closest to?" cards. The 2 km tier is
// dense/local features; the 25 km tier is sparse/regional ones.
//
// "Metro Lines" is the odd one: it is answered with a LINE, and Google exposes no
// queryable line geometry at all (TransitLayer is raster tiles). It used to be proxied
// with metro stations — stations sit on the lines — but that answers a different
// question wherever station spacing exceeds line spacing (F1). `lineKind` sources real
// line geometry from OSM via the Overpass proxy instead. `type` is retained as the
// fallback for when no proxy is configured or Overpass is down, and `approx` is the
// warning shown ONLY on that fallback path.
export const TENTACLES = [
  // 2 km tier
  { id: "museum", label: "Museums", type: "museum", radius: 2000 },
  { id: "library", label: "Libraries", type: "library", radius: 2000 },
  { id: "movie_theater", label: "Movie Theaters", type: "movie_theater", radius: 2000 },
  { id: "hospital", label: "Hospitals", type: "hospital", radius: 2000 },
  // 25 km tier
  { id: "subway_station", label: "Metro Lines", lineKind: "metro", type: "subway_station", radius: 25000, approx: "via metro stations" },
  { id: "zoo", label: "Zoos", type: "zoo", radius: 25000 },
  { id: "aquarium", label: "Aquariums", type: "aquarium", radius: 25000 },
  { id: "amusement_park", label: "Amusement Parks", type: "amusement_park", radius: 25000 },
];

export function findTentacle(id) {
  return TENTACLES.find((c) => c.id === id) || null;
}

// ---- Matching -----------------------------------------------------------
// The SEEKER asks "is your nearest ___ (or your ___) the same as mine?" The
// seeker enters THEIR own value and the hider answers yes (same) / no (different);
// the app keeps the seeker's region on "same" and removes it on "different".
// Each card has a `mode`:
//   nearest     — nearest-of-a-category (Voronoi over Google Places points).
//   nameLength  — nearest transit station, grouped by name letter-count.
//   nearestLine — nearest of several lines/paths you draw (no Google geometry).
//   region      — which drawn region (admin division / landmass) you're inside.
export const MATCHING = [
  { id: "airport", label: "Commercial Airport", mode: "nearest", type: "airport" },
  { id: "transit_line", label: "Transit Line", mode: "nearestLine" },
  { id: "name_length", label: "Station's Name Length", mode: "nameLength", type: "transit_station" },
  { id: "street", label: "Street or Path", mode: "nearestLine" },
  { id: "admin1", label: "1st Admin. Division", mode: "region" },
  { id: "admin2", label: "2nd Admin. Division", mode: "region" },
  { id: "admin3", label: "3rd Admin. Division", mode: "region" },
  { id: "admin4", label: "4th Admin. Division", mode: "region" },
  { id: "mountain", label: "Mountain", mode: "nearest", keyword: "mountain" },
  { id: "landmass", label: "Landmass", mode: "region" },
  { id: "park", label: "Park", mode: "nearest", type: "park" },
  { id: "amusement_park", label: "Amusement Park", mode: "nearest", type: "amusement_park" },
  { id: "zoo", label: "Zoo", mode: "nearest", type: "zoo" },
  { id: "aquarium", label: "Aquarium", mode: "nearest", type: "aquarium" },
  { id: "golf", label: "Golf Course", mode: "nearest", keyword: "golf course" },
  { id: "museum", label: "Museum", mode: "nearest", type: "museum" },
  { id: "movie_theater", label: "Movie Theater", mode: "nearest", type: "movie_theater" },
  { id: "hospital", label: "Hospital", mode: "nearest", type: "hospital" },
  { id: "library", label: "Library", mode: "nearest", type: "library" },
  { id: "consulate", label: "Foreign Consulate", mode: "nearest", keyword: "consulate" },
];

export function findMatching(id) {
  return MATCHING.find((c) => c.id === id) || null;
}

// ---- Measuring ----------------------------------------------------------
// The SEEKER asks "are you closer to / farther from the nearest ___ than me?"
// The seeker enters THEIR distance D; the hider answers closer (within) / farther
// (beyond); the app buffers the reference by D and keeps the inside (closer) or
// outside (farther). Each card has a `ref` describing where the reference comes
// from — the source is fully automatic where Google can provide it, else a
// manual on-map draw (per the game's non-point features):
//   points — nearest-of-a-category buffered (Google Places point set).
//   line   — a reference line, buffered. Google has no line geometry for any of these
//            (§G0), so they come from OpenStreetMap via the Overpass proxy when the card
//            names a `lineKind`, and are hand-drawn only where no worldwide-valid query
//            exists. A hand-drawn coastline is a traced guess: it decides real
//            eliminations at whatever accuracy a fingertip managed.
//   area   — a hand-drawn polygon (a body of water), buffered from its shore.
//   region — Sea Level: elevation isn't derivable from map geometry, so draw the
//            region above/below the revealed level and keep that side (no buffer).
//
// `lineKind` (+ `level` for borders) is the Overpass source. It is set only where ONE query
// is right everywhere — no per-city tuning, so no board gets an advantage:
//   coastline    — natural=coastline is a single unambiguous tag worldwide.
//   intl_border  — admin_level=2 is the international border by definition.
//   admin1_border— admin_level=4 measured as the 1st division in 14/14 countries sampled.
// Deliberately NOT set (they stay hand-drawn, and the card says so rather than guessing):
//   admin2_border— the 2nd division has NO fixed admin_level (it is 5 in some countries,
//                  6 in others, 8 elsewhere). Picking one would be silently wrong in every
//                  country it didn't match — the §A failure mode, worldwide.
//   hs_train     — OSM tags high-speed service inconsistently across networks; no single
//                  query returns "the high-speed lines" everywhere yet.
export const MEASURING = [
  { id: "airport", label: "Commercial Airport", ref: "points", type: "airport" },
  { id: "hs_train", label: "High Speed Train Line", ref: "line" },
  { id: "rail_station", label: "Rail Station", ref: "points", type: "train_station" },
  { id: "intl_border", label: "International Border", ref: "line", lineKind: "border", level: 2 },
  { id: "admin1_border", label: "1st Admin. Division Border", ref: "line", lineKind: "border", level: 4 },
  { id: "admin2_border", label: "2nd Admin. Division Border", ref: "line" },
  { id: "sea_level", label: "Sea Level", ref: "region" },
  { id: "water", label: "Body of Water", ref: "area" },
  { id: "coastline", label: "Coastline", ref: "line", lineKind: "coastline" },
  { id: "mountain", label: "Mountain", ref: "points", keyword: "mountain" },
  { id: "park", label: "Park", ref: "points", type: "park" },
  { id: "amusement_park", label: "Amusement Park", ref: "points", type: "amusement_park" },
  { id: "zoo", label: "Zoo", ref: "points", type: "zoo" },
  { id: "aquarium", label: "Aquarium", ref: "points", type: "aquarium" },
  { id: "golf", label: "Golf Course", ref: "points", keyword: "golf course" },
  { id: "museum", label: "Museum", ref: "points", type: "museum" },
  { id: "movie_theater", label: "Movie Theater", ref: "points", type: "movie_theater" },
  { id: "hospital", label: "Hospital", ref: "points", type: "hospital" },
  { id: "library", label: "Library", ref: "points", type: "library" },
  { id: "consulate", label: "Foreign Consulate", ref: "points", keyword: "consulate" },
];

export function findMeasuring(id) {
  return MEASURING.find((c) => c.id === id) || null;
}
