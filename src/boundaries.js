// Reference boundary overlays.
//
// Search a place and display its OFFICIAL Google administrative boundary as a
// non-interactive REFERENCE layer, so the user can eyeball it and hand-plot
// their own zone points. These overlays are NEVER added to the game as zones —
// searching another place leaves any drawn zones completely untouched.
//
// Exact boundaries use Google's Data-driven styling (DDS) "boundaries" feature,
// which needs a vector Map ID configured for Data-driven styling. When that is
// not available we fall back to the geocoder's official viewport as an
// approximate rectangle so the feature still gives a usable reference.

// Geocoder result primary type -> DDS FeatureType enum name.
const TYPE_TO_FEATURE = {
  country: "COUNTRY",
  administrative_area_level_1: "ADMINISTRATIVE_AREA_LEVEL_1",
  administrative_area_level_2: "ADMINISTRATIVE_AREA_LEVEL_2",
  administrative_area_level_3: "ADMINISTRATIVE_AREA_LEVEL_3",
  administrative_area_level_4: "ADMINISTRATIVE_AREA_LEVEL_4",
  locality: "LOCALITY",
  postal_code: "POSTAL_CODE",
  sublocality: "SUBLOCALITY_LEVEL_1",
  sublocality_level_1: "SUBLOCALITY_LEVEL_1",
  school_district: "SCHOOL_DISTRICT",
};

// Style for an exact DDS boundary (returned from the feature-style function).
const BOUNDARY_STYLE = {
  strokeColor: "#a78bfa",
  strokeWeight: 2.5,
  strokeOpacity: 1,
  fillColor: "#a78bfa",
  fillOpacity: 0.08,
};

// Style for the approximate viewport rectangle fallback.
const BOX_STYLE = {
  strokeColor: "#a78bfa",
  strokeOpacity: 0.9,
  strokeWeight: 2,
  fillColor: "#a78bfa",
  fillOpacity: 0.05,
  clickable: false,
};

export class Boundaries {
  constructor(map, { ddsAvailable = false } = {}) {
    this.map = map;
    this.ddsAvailable = ddsAvailable;
    this.geocoder = null;
    // DDS state: featureName -> { layer, placeIds:Set }
    this._featureLayers = new Map();
    // Fallback state: array of google.maps.Polygon rectangles.
    this._boxes = [];
  }

  _ensureGeocoder() {
    if (!this.geocoder) this.geocoder = new google.maps.Geocoder();
    return this.geocoder;
  }

  // Geocode free text -> candidate results (may be several: a city vs a state).
  async search(query) {
    const geocoder = this._ensureGeocoder();
    return new Promise((resolve, reject) => {
      geocoder.geocode({ address: query }, (results, status) => {
        if (status === "OK" && results?.length) resolve(results);
        else if (status === "ZERO_RESULTS") resolve([]);
        else reject(new Error(`Region search failed (${status}).`));
      });
    });
  }

  // Overlay the official boundary for a geocoder result. Returns { mode }:
  //   "exact"  — DDS administrative boundary drawn,
  //   "approx" — fell back to the official viewport rectangle.
  show(result) {
    this._fitTo(result.geometry);
    const type = (result.types || []).find((t) => TYPE_TO_FEATURE[t]);
    const featureName = type ? TYPE_TO_FEATURE[type] : null;

    if (this.ddsAvailable && featureName && result.place_id) {
      if (this._highlightFeature(featureName, result.place_id)) return { mode: "exact" };
    }
    this._drawBox(result.geometry);
    return { mode: "approx" };
  }

  _highlightFeature(featureName, placeId) {
    try {
      const type = google.maps.FeatureType?.[featureName];
      if (!type) return false;
      let entry = this._featureLayers.get(featureName);
      if (!entry) {
        const layer = this.map.getFeatureLayer(type);
        entry = { layer, placeIds: new Set() };
        this._featureLayers.set(featureName, entry);
      }
      entry.placeIds.add(placeId);
      const placeIds = entry.placeIds; // captured by the style function
      entry.layer.style = (params) =>
        placeIds.has(params.feature.placeId) ? BOUNDARY_STYLE : null;
      return true;
    } catch (e) {
      console.warn("DDS boundary unavailable, using approximate box:", e);
      return false;
    }
  }

  _drawBox(geometry) {
    const b = geometry?.bounds || geometry?.viewport;
    if (!b) return;
    const ne = b.getNorthEast();
    const sw = b.getSouthWest();
    const path = [
      { lat: sw.lat(), lng: sw.lng() },
      { lat: sw.lat(), lng: ne.lng() },
      { lat: ne.lat(), lng: ne.lng() },
      { lat: ne.lat(), lng: sw.lng() },
    ];
    this._boxes.push(new google.maps.Polygon({ ...BOX_STYLE, paths: path, map: this.map }));
  }

  _fitTo(geometry) {
    const b = geometry?.bounds || geometry?.viewport;
    if (b) this.map.fitBounds(b, 48);
    else if (geometry?.location) this.map.setCenter(geometry.location);
  }

  hasOverlays() {
    if (this._boxes.length) return true;
    for (const { placeIds } of this._featureLayers.values()) if (placeIds.size) return true;
    return false;
  }

  clear() {
    this._boxes.forEach((p) => p.setMap(null));
    this._boxes = [];
    for (const entry of this._featureLayers.values()) {
      entry.placeIds.clear();
      try { entry.layer.style = null; } catch { /* layer may be gone */ }
    }
  }
}
