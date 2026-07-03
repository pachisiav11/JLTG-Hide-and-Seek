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
