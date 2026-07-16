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

// Free-text place search. Resolves to [{ name, lat, lng, address }]. An optional
// `{ location, radius }` biases results toward a centre (e.g. the seeker) so a
// query like "derby" prefers the Derby near you over a namesake far away.
export function searchText(map, query, { location, radius } = {}) {
  const svc = getService(map);
  const req = { query };
  if (location) { req.location = location; req.radius = Math.min(50000, Math.max(1, radius || 30000)); }
  return new Promise((resolve, reject) => {
    svc.textSearch(req, (results, status) => {
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

// DDS-highlightable admin levels, outermost→innermost. Google's Data-Driven
// Styling only exposes FeatureLayers for these (there is no level-3/-4 FeatureType),
// so the tracing helper can only draw these boundaries even though the game asks
// about 1st–4th divisions. Geocoding `type` → DDS FeatureType enum name.
const DDS_ADMIN_LEVELS = [
  { type: "administrative_area_level_1", feature: "ADMINISTRATIVE_AREA_LEVEL_1", label: "1st Admin division" },
  { type: "administrative_area_level_2", feature: "ADMINISTRATIVE_AREA_LEVEL_2", label: "2nd Admin division" },
  { type: "locality",                    feature: "LOCALITY",                    label: "City / locality (≈3rd)" },
];

// Reverse-geocode a point into the admin divisions Data-Driven Styling can
// highlight. Returns [{ feature, label, placeId, name }] outermost→innermost for
// the levels present at that point (each with its own placeId, used to style the
// exact FeatureLayer boundary). Empty if none resolve.
export function adminDivisionsAt({ lat, lng }) {
  if (!geocoder) geocoder = new google.maps.Geocoder();
  return new Promise((resolve, reject) => {
    geocoder.geocode({ location: { lat, lng } }, (results, status) => {
      if (status === "ZERO_RESULTS") { resolve([]); return; }
      if (status !== "OK" || !results?.length) { reject(new Error(`Reverse geocode failed (${status}).`)); return; }
      const out = [];
      for (const lvl of DDS_ADMIN_LEVELS) {
        const r = results.find((res) => (res.types || []).includes(lvl.type) && res.place_id);
        if (r) out.push({ feature: lvl.feature, label: lvl.label, placeId: r.place_id, name: (r.address_components?.[0]?.long_name) || r.formatted_address || lvl.label });
      }
      resolve(out);
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

// How long to wait before spending a next-page token. Google's token needs ~2 s to
// activate; calling sooner returns INVALID_REQUEST. This was 1600 ms — contradicting the
// comment that sat beside it — so page 2 usually errored and the caller quietly resolved
// page one, capping lists at exactly 20. Kept above 2 s, with one retry (see `retried`).
const PAGE_TOKEN_MS = 2500;

// Search a category near a centre. Resolves to [{ name, lat, lng }]. `keyword`
// optionally narrows results (e.g. "McDonald's"). Radius is clamped to the API max.
// nearbySearch returns only 20 per page; we follow pagination up to `maxPages`
// (Google caps at 3 → ~60 results) so dense categories aren't silently truncated
// to 20. Each nextPage() needs a short delay before the token is valid.
export function searchCategory(map, { center, radius, type, keyword, maxPages = 3 }) {
  const svc = getService(map);
  const request = {
    location: center,
    radius: Math.min(50000, Math.max(50, radius || 3000)),
  };
  if (type) request.type = type;
  if (keyword) request.keyword = keyword;

  return new Promise((resolve, reject) => {
    const all = [];
    const seen = new Set();
    let pages = 0;
    let pager = null;      // the pagination object from the last OK page
    let retried = false;   // one retry per page token
    const handle = (results, status, pagination) => {
      const S = google.maps.places.PlacesServiceStatus;
      if (status === S.OK && results) {
        for (const r of results) {
          if (!(r.geometry && r.geometry.location)) continue;
          const lat = r.geometry.location.lat(), lng = r.geometry.location.lng();
          const key = r.place_id || `${lat.toFixed(6)},${lng.toFixed(6)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          all.push({ name: r.name || "(unnamed)", lat, lng });
        }
        pages++;
        retried = false;
        if (pagination && pagination.hasNextPage && pages < maxPages) {
          pager = pagination;
          setTimeout(() => pagination.nextPage(), PAGE_TOKEN_MS);
        } else {
          resolve(all);
        }
      } else if (status === S.INVALID_REQUEST && pager && !retried) {
        // The token wasn't active yet. Retry once instead of letting a page-2 failure
        // resolve page one as though it were the complete result — that fallback is the
        // likely reason lists came back with exactly 20 entries.
        retried = true;
        setTimeout(() => pager.nextPage(), PAGE_TOKEN_MS);
      } else if (status === S.ZERO_RESULTS) {
        resolve(all);
      } else if (all.length) {
        // Genuinely stuck after a retry: keep what we have, but say so — a truncated list
        // silently partitions the map from an arbitrary subset.
        console.warn(`Places pagination stopped at ${status} after ${pages} page(s); returning ${all.length} results, which may be incomplete.`);
        resolve(all);
      } else {
        reject(new Error(`Places search failed: ${status}`));
      }
    };
    svc.nearbySearch(request, handle);
  });
}

// ---- Source strategy: Overpass vs Google -------------------------------------
// Overpass (via the Render proxy) is the PRIMARY source for dense categories; Google
// Places is primary for the rest, with Overpass consulted on failure, a thin result, or
// Google's cap. Gated on a configured OVERPASS_PROXY_URL — with none, this is Google-only.
//
// Why: Google's nearbySearch queries a RADIUS AROUND A POINT and hard-caps at 60 results
// (3 pages x 20). Overpass queries a REGION and has no top-N cap at all — only a timeout.
// Measured: a Mumbai bbox returned 75 route relations and 7115 ways with no cap.
//
// The old rule was `if (!googleErr && feats.length >= THIN) return google` with THIN = 2.
// In London, Google returns its 60-station cap, 60 >= 2, and the ~400-station OSM dataset
// was never consulted. Overpass only ever fired on API *failure*, never for *completeness*
// — so the cap, not the data, decided the partition.

const THIN = 2; // fewer than this ⇒ Google clearly didn't answer; consult OSM

// Google's nearbySearch hard cap. A result AT the cap is truncated BY DEFINITION: it is
// the ceiling, not the answer. Treat it as a reason to consult the uncapped source.
const GOOGLE_CAP = 60;

// Categories whose true count inside one play area routinely exceeds Google's 60-cap, so
// the cap would silently partition the map from an arbitrary subset. These go to Overpass
// FIRST. Every mature tool in this space made the same call, for the same reason.
const DENSE_CATEGORIES = new Set([
  "train_station", "subway_station", "bus_station", "transit_station",
  "restaurant", "school", "place_of_worship", "park",
]);

// Client-supported category keys (must mirror server CATEGORY_TAGS). A card's
// Google `type` is used directly when it's one of these; keyword-only cards map by
// keyword. Returns an Overpass category key or null (⇒ no fallback for this card).
const OVERPASS_TYPES = new Set([
  "hospital", "park", "museum", "library", "movie_theater", "zoo", "aquarium",
  "amusement_park", "train_station", "subway_station", "bus_station", "transit_station",
  "airport", "school", "place_of_worship", "tourist_attraction", "restaurant", "shopping_mall",
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

// Resolve a category to points, choosing the source per category and per area (not a
// global switch — IMPROVEMENTS §10).
//
// Returns { feats, source: "google"|"overpass", reason }, where `reason` says WHY that
// source won, so callers can word the toast honestly: "overpass" is now the intended
// primary for dense cards, not evidence that Places broke.
//   primary    — the source we chose first, and it worked
//   fallback   — the primary errored
//   thin       — the primary returned almost nothing
//   uncapped   — Google hit its 60-cap and OSM had genuinely more
export async function searchCategoryResilient(map, { center, radius, type, keyword, gameArea, padMeters = 0 }) {
  const proxy = window.JLTG_CONFIG?.OVERPASS_PROXY_URL;
  const cat = deriveOverpassCategory({ type, keyword });
  const bbox = areaBboxSWNE(gameArea, padMeters);
  const canOverpass = !!(proxy && cat && bbox);
  // Only send a keyword to OSM for keyword-only cards (a place type is more reliable than
  // a name substring server-side).
  const osmKeyword = !type && keyword ? keyword : "";
  const askOverpass = () => overpassCategory(proxy, cat, bbox, osmKeyword);

  // ---- Dense cards: Overpass FIRST -------------------------------------------------
  // The whole point of B2. Google cannot answer "every station on this board" — its cap
  // decides the answer instead of the data.
  if (canOverpass && DENSE_CATEGORIES.has(cat)) {
    try {
      const osm = await askOverpass();
      if (osm.length) return { feats: osm, source: "overpass", reason: "primary" };
      // An empty OSM answer is not authoritative (thin mapping, odd tagging) — ask Google.
    } catch (e) {
      // Overpass fails ~64% of individual attempts; the proxy retries hard (see D3), so
      // reaching here means it really is unavailable. Google's capped answer beats none.
      console.warn("Overpass primary failed; falling back to Google:", e.message);
    }
    let feats = [];
    try { feats = await searchCategory(map, { center, radius, type, keyword }); }
    catch (googleErr) { throw googleErr; } // both sources failed — surface it
    return { feats, source: "google", reason: "fallback" };
  }

  // ---- Everything else: Google first ------------------------------------------------
  let feats = [], googleErr = null;
  try { feats = await searchCategory(map, { center, radius, type, keyword }); }
  catch (e) { googleErr = e; }

  // Consult OSM when Google failed, said almost nothing, OR hit its cap. That last case is
  // the one THIN could never catch: 60 >= 2, so a truncated list looked complete.
  const capped = feats.length >= GOOGLE_CAP;
  if (canOverpass && (googleErr || feats.length < THIN || capped)) {
    try {
      const osm = await askOverpass();
      if (googleErr) {
        if (osm.length) return { feats: osm, source: "overpass", reason: "fallback" };
      } else if (osm.length > feats.length) {
        return { feats: osm, source: "overpass", reason: capped ? "uncapped" : "thin" };
      }
    } catch (e) { console.warn("Overpass fallback failed:", e.message); }
  }
  if (googleErr && !feats.length) throw googleErr; // nothing worked
  if (capped) {
    // Still capped: the partition is being built from an arbitrary 60. Say so.
    console.warn(`Places returned its ${GOOGLE_CAP}-result cap for "${type || keyword}" and OSM could not improve on it — the candidate list may be truncated.`);
  }
  return { feats, source: "google", reason: "primary" };
}
