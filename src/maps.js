// Google Maps JavaScript API loader.
// Loads the API once with the libraries the app actually uses:
//   maps, places, geometry (features.js computeDistanceBetween), marker.
// Exposes google.maps.importLibrary(...) for on-demand library access.
//
// `drawing` and `visualization` were loaded here and never referenced. `drawing` could not
// have been used even in principle — zones.js:30 records that DrawingManager was removed from
// Maps JS in v3.65, which is why zones are drawn with a custom click tool — and there is no
// heatmap or other visualization primitive anywhere. Two libraries off the first payload, on a
// phone, outdoors, which is the target device. (`routes` is imported on demand in features.js.)

let loadPromise = null;

const LIBRARIES = ["maps", "places", "geometry", "marker"];

export function loadGoogleMaps(apiKey) {
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps) {
      resolve(window.google.maps);
      return;
    }
    if (!apiKey || apiKey === "YOUR_API_KEY_HERE") {
      reject(new Error("Missing Google Maps API key. Set GOOGLE_MAPS_API_KEY in config.js."));
      return;
    }

    const callbackName = "__jltgGmapsReady";
    window[callbackName] = () => {
      delete window[callbackName];
      resolve(window.google.maps);
    };

    const params = new URLSearchParams({
      key: apiKey,
      v: "weekly",
      libraries: LIBRARIES.join(","),
      callback: callbackName,
      loading: "async",
    });

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error("Failed to load the Google Maps script (network or key/referrer restriction?)."));
    document.head.appendChild(script);
  });

  return loadPromise;
}

// Create the base map into the given element.
// A vector `mapId` (optional) enables Data-driven styling for official region
// boundaries; without one the app falls back to approximate viewport extents.
export async function createMap(element, { center, zoom, mapId }) {
  const { Map } = await google.maps.importLibrary("maps");
  const opts = {
    center,
    zoom,
    disableDefaultUI: false,
    zoomControl: true,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
    gestureHandling: "greedy",
  };
  if (mapId) opts.mapId = mapId;
  const map = new Map(element, opts);
  return map;
}

// A dark base-map style (Phase 12). Applied via setOptions({ styles }); note this
// has NO effect when a vector `mapId` is set (that map is styled in the cloud) —
// applyMapStyle handles that case by warning rather than silently no-op'ing.
export const DARK_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#212121" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#757575" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#212121" }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#757575" }] },
  { featureType: "administrative.country", elementType: "labels.text.fill", stylers: [{ color: "#9e9e9e" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#bdbdbd" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#757575" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#181818" }] },
  { featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#2c2c2c" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8a8a8a" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#373737" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3c3c3c" }] },
  { featureType: "transit", elementType: "labels.text.fill", stylers: [{ color: "#757575" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#000000" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3d3d3d" }] },
];

// Switch the base map style (Phase 12): "roadmap" (default), "satellite" (hybrid,
// keeps labels) or "dark". Returns a warning string if a request can't fully apply
// (dark style + a vector Map ID), else null.
export function applyMapStyle(map, style, { hasMapId = false } = {}) {
  if (!map) return null;
  if (style === "satellite") {
    map.setMapTypeId("hybrid");
    try { map.setOptions({ styles: null }); } catch (_) {}
    return null;
  }
  if (style === "dark") {
    map.setMapTypeId("roadmap");
    if (hasMapId) return "Dark style needs no Map ID (a vector map is styled in Google Cloud instead).";
    try { map.setOptions({ styles: DARK_STYLE }); } catch (_) {}
    return null;
  }
  map.setMapTypeId("roadmap");
  try { map.setOptions({ styles: null }); } catch (_) {}
  return null;
}
