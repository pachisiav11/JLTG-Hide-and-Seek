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

// Free-text place search (for the Directions tab). Resolves to
// [{ name, lat, lng, address }].
export function searchText(map, query) {
  const svc = getService(map);
  return new Promise((resolve, reject) => {
    svc.textSearch({ query }, (results, status) => {
      const S = google.maps.places.PlacesServiceStatus;
      if (status === S.OK && results) {
        resolve(results.filter((r) => r.geometry?.location).map((r) => ({
          name: r.name || r.formatted_address || "(unnamed)",
          address: r.formatted_address || "",
          lat: r.geometry.location.lat(),
          lng: r.geometry.location.lng(),
        })));
      } else if (status === S.ZERO_RESULTS) {
        resolve([]);
      } else {
        reject(new Error(`Search failed: ${status}`));
      }
    });
  });
}

// Reverse-geocode a point into its administrative divisions (Phase 9). Returns a
// normalized { neighbourhood, city, county, state, country } — each a display name
// or undefined. Used by the admin-division comparison tool. Uses google.maps.Geocoder
// (a separate product from PlacesService); a lightweight singleton geocoder is reused.
let geocoder = null;
export function reverseGeocode({ lat, lng }) {
  if (!geocoder) geocoder = new google.maps.Geocoder();
  return new Promise((resolve, reject) => {
    geocoder.geocode({ location: { lat, lng } }, (results, status) => {
      if (status === "OK" && results?.length) resolve(extractAdminLevels(results));
      else if (status === "ZERO_RESULTS") resolve({});
      else reject(new Error(`Reverse geocode failed (${status}).`));
    });
  });
}

// Scan all result components for the first name at each admin level. Google labels
// vary by country, so several component types map to one conceptual level.
function extractAdminLevels(results) {
  const pick = (types) => {
    for (const r of results) {
      for (const c of r.address_components || []) {
        if (types.some((t) => (c.types || []).includes(t))) return c.long_name;
      }
    }
    return undefined;
  };
  return {
    neighbourhood: pick(["neighborhood", "sublocality", "sublocality_level_1"]),
    city: pick(["locality", "postal_town", "administrative_area_level_3"]),
    county: pick(["administrative_area_level_2"]),
    state: pick(["administrative_area_level_1"]),
    country: pick(["country"]),
  };
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
