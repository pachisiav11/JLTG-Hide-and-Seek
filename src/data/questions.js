// The Jet Lag: The Game question bank, as data that drives the question tools.
// Source of truth: docs/jetlag_questions.md. Each tool exposes ONLY these items.
//
// `type` is a Google Places (nearbySearch) place type used to source the feature
// points automatically. `radius` (metres) is the fixed tentacle range per card.
// `approx` notes when the automatic source is a proxy for the real feature.

// ---- Tentacles ----------------------------------------------------------
// Fixed-radius "of these, which are you closest to?" cards. The 2 km tier is
// dense/local features; the 25 km tier is sparse/regional ones. "Metro Lines"
// has no queryable line geometry from Google, so we proxy it with metro stations
// (stations sit on the lines) — an automatic approximation.
export const TENTACLES = [
  // 2 km tier
  { id: "museum", label: "Museums", type: "museum", radius: 2000 },
  { id: "library", label: "Libraries", type: "library", radius: 2000 },
  { id: "movie_theater", label: "Movie Theaters", type: "movie_theater", radius: 2000 },
  { id: "hospital", label: "Hospitals", type: "hospital", radius: 2000 },
  // 25 km tier
  { id: "subway_station", label: "Metro Lines", type: "subway_station", radius: 25000, approx: "via metro stations" },
  { id: "zoo", label: "Zoos", type: "zoo", radius: 25000 },
  { id: "aquarium", label: "Aquariums", type: "aquarium", radius: 25000 },
  { id: "amusement_park", label: "Amusement Parks", type: "amusement_park", radius: 25000 },
];

export function findTentacle(id) {
  return TENTACLES.find((c) => c.id === id) || null;
}

// ---- Matching -----------------------------------------------------------
// "Is your nearest ___ (or your ___) the same as mine?" Reveal the hider's
// value; the app keeps the region that matches it. Each card has a `mode`:
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
