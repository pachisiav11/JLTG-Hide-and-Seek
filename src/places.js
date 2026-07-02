// Places API integration for the Voronoi tools (Matching & Tentacles).
// Uses the classic PlacesService.nearbySearch, which is served by the "Places API"
// product the project has enabled. Returns a plain [{ name, lat, lng }] list that
// gets stored in the step's inputs (so the Voronoi partition can be recomputed
// deterministically later — Places results are not stable over time).

export const CATEGORIES = [
  { id: "train_station", label: "Railway station", type: "train_station" },
  { id: "subway_station", label: "Metro / subway", type: "subway_station" },
  { id: "bus_station", label: "Bus station", type: "bus_station" },
  { id: "park", label: "Park", type: "park" },
  { id: "hospital", label: "Hospital", type: "hospital" },
  { id: "school", label: "School", type: "school" },
  { id: "place_of_worship", label: "Place of worship", type: "place_of_worship" },
  { id: "tourist_attraction", label: "Tourist attraction", type: "tourist_attraction" },
  { id: "shopping_mall", label: "Shopping mall", type: "shopping_mall" },
  { id: "restaurant", label: "Restaurant", type: "restaurant" },
];

let service = null;

function getService(map) {
  if (!service) service = new google.maps.places.PlacesService(map);
  return service;
}

// Search a category near a centre. Resolves to [{ name, lat, lng }]. `keyword`
// optionally narrows results (e.g. "McDonald's"). Radius is clamped to the API max.
export function searchCategory(map, { center, radius, type, keyword }) {
  const svc = getService(map);
  const request = {
    location: center,
    radius: Math.min(50000, Math.max(50, radius || 3000)),
  };
  if (type) request.type = type;
  if (keyword) request.keyword = keyword;

  return new Promise((resolve, reject) => {
    svc.nearbySearch(request, (results, status) => {
      const S = google.maps.places.PlacesServiceStatus;
      if (status === S.OK && results) {
        resolve(
          results
            .filter((r) => r.geometry && r.geometry.location)
            .map((r) => ({
              name: r.name || "(unnamed)",
              lat: r.geometry.location.lat(),
              lng: r.geometry.location.lng(),
            }))
        );
      } else if (status === S.ZERO_RESULTS) {
        resolve([]);
      } else {
        reject(new Error(`Places search failed: ${status}`));
      }
    });
  });
}
