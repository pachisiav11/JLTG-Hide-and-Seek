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
export async function createMap(element, { center, zoom }) {
  const { Map } = await google.maps.importLibrary("maps");
  const map = new Map(element, {
    center,
    zoom,
    disableDefaultUI: false,
    zoomControl: true,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
    gestureHandling: "greedy",
    // A Map ID is required for Advanced Markers; without one we fall back fine.
  });
  return map;
}
