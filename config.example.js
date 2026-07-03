// Copy this file to `config.js` and fill in your key.
// `config.js` is git-ignored so your real key never lands in the public repo.
//
// NOTE: For the Maps JavaScript API the key is sent from the browser and is
// therefore visible in network requests at runtime. Git-ignoring keeps it out
// of source control, but for any *hosted* deployment you must ALSO restrict the
// key in Google Cloud (HTTP referrers + the 4 enabled APIs) or it can be abused.
window.JLTG_CONFIG = {
  // Google Maps Platform API key.
  GOOGLE_MAPS_API_KEY: "YOUR_API_KEY_HERE",

  // OPTIONAL: a vector Map ID with Data-driven styling enabled. Set this to
  // overlay EXACT official Google region boundaries (🌍 Region boundary). Leave
  // as-is / blank to fall back to approximate viewport rectangles.
  MAP_ID: "YOUR_MAP_ID_HERE",

  // Map defaults — Singapore / Marina Bay area (adjust to your play region).
  DEFAULT_CENTER: { lat: 1.2830, lng: 103.8590 },
  DEFAULT_ZOOM: 12,
};
