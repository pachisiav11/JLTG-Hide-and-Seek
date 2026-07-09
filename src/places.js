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

// ---- Overpass fallback (Phase 10) --------------------------------------------
// Google Places is the DEFAULT; Overpass (via the Render proxy) is a FALLBACK for
// when Places fails / is quota-exhausted or returns too few results. Gated on a
// configured OVERPASS_PROXY_URL — with none, this is a no-op and Google-only.

const THIN = 2; // fewer than this ⇒ try the OSM fallback

// Client-supported category keys (must mirror server CATEGORY_TAGS). A card's
// Google `type` is used directly when it's one of these; keyword-only cards map by
// keyword. Returns an Overpass category key or null (⇒ no fallback for this card).
const OVERPASS_TYPES = new Set([
  "hospital", "park", "museum", "library", "movie_theater", "zoo", "aquarium",
  "amusement_park", "train_station", "subway_station", "bus_station", "airport",
  "school", "place_of_worship", "tourist_attraction", "restaurant", "shopping_mall",
]);
const KEYWORD_TO_OVERPASS = { mountain: "mountain", "golf course": "golf", consulate: "consulate" };

function deriveOverpassCategory({ type, keyword }) {
  if (type && OVERPASS_TYPES.has(type)) return type;
  const k = (keyword || "").trim().toLowerCase();
  return KEYWORD_TO_OVERPASS[k] || null;
}

// [minX,minY,maxX,maxY] bbox of a game-area polygon, optionally padded by ~meters,
// formatted as the "S,W,N,E" string the proxy expects. Null if turf/area missing.
function areaBboxSWNE(gameArea, padMeters = 0) {
  const turf = window.turf;
  if (!turf || !gameArea) return null;
  try {
    const bb = turf.bbox(gameArea.type === "Feature" ? gameArea : turf.feature(gameArea));
    const dLat = padMeters / 111320;
    const midLat = (bb[1] + bb[3]) / 2;
    const dLng = padMeters / (111320 * Math.max(0.05, Math.cos((midLat * Math.PI) / 180)));
    const s = bb[1] - dLat, w = bb[0] - dLng, n = bb[3] + dLat, e = bb[2] + dLng;
    return `${s},${w},${n},${e}`;
  } catch (_) { return null; }
}

async function overpassCategory(proxyBase, category, bboxStr, keyword) {
  const base = proxyBase.replace(/\/+$/, "");
  const url = new URL(base + "/overpass");
  url.searchParams.set("category", category);
  url.searchParams.set("bbox", bboxStr);
  if (keyword) url.searchParams.set("keyword", keyword);
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Overpass proxy HTTP ${resp.status}`);
  const json = await resp.json();
  return (json.features || []).map((f) => ({ name: f.name, lat: f.lat, lng: f.lng }));
}

// Google Places first; on error or a thin result, fall back to Overpass (if
// configured) over the game-area bbox. Returns { feats, source: "google"|"overpass" }.
// A per-category, per-area decision — not a global source switch (IMPROVEMENTS §10).
export async function searchCategoryResilient(map, { center, radius, type, keyword, gameArea, padMeters = 0 }) {
  let feats = [], googleErr = null;
  try { feats = await searchCategory(map, { center, radius, type, keyword }); }
  catch (e) { googleErr = e; }
  if (!googleErr && feats.length >= THIN) return { feats, source: "google" };

  const proxy = window.JLTG_CONFIG?.OVERPASS_PROXY_URL;
  const cat = deriveOverpassCategory({ type, keyword });
  const bbox = areaBboxSWNE(gameArea, padMeters);
  if (proxy && cat && bbox) {
    try {
      // Only send a keyword to OSM for keyword-only cards (a place type is more
      // reliable than a name substring server-side).
      const osm = await overpassCategory(proxy, cat, bbox, !type && keyword ? keyword : "");
      if (googleErr) { if (osm.length) return { feats: osm, source: "overpass" }; }
      else if (osm.length > feats.length) return { feats: osm, source: "overpass" };
    } catch (e) { console.warn("Overpass fallback failed:", e.message); }
  }
  if (googleErr && !feats.length) throw googleErr; // nothing worked
  return { feats, source: "google" };
}
