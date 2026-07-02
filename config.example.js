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

  // Map defaults — Mumbai / Juhu area (adjust to your play region).
  DEFAULT_CENTER: { lat: 19.099, lng: 72.826 },
  DEFAULT_ZOOM: 13,
};
