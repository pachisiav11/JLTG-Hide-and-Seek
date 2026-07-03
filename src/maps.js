// Google Maps JavaScript API loader.
// Loads the API once with all libraries the app will need across phases:
//   maps, places, geometry, drawing, marker, visualization  (guide §3).
// Exposes google.maps.importLibrary(...) for on-demand library access.

let loadPromise = null;

const LIBRARIES = ["maps", "places", "geometry", "drawing", "marker", "visualization"];

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
