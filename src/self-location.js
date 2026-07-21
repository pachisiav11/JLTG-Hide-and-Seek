// Phase 36 (req #7a): the blue "you are here" self-dot + accuracy ring.
//
// A gmaps-style dot that follows the device's own GPS, always on, so both roles
// can see where they are on the board without any tool active. It rides the
// shared GeoWatch (Phase 36) — no watch of its own — and asks for the cached
// last fix on subscribe so it draws immediately instead of waiting a GPS cycle.
//
// Marker + accuracy circle are created lazily on the first fix and moved (not
// recreated) on every subsequent one — google.maps.Marker/Circle churn is
// expensive in a hot update loop.

import { geoWatch } from "./geo-watch.js";

const DOT_STYLE = {
  fillColor: "#4285F4",   // Google-maps blue
  fillOpacity: 1,
  strokeColor: "#ffffff",
  strokeWeight: 2,
  scale: 7,
};
const RING_STYLE = {
  strokeColor: "#4285F4",
  strokeOpacity: 0.4,
  strokeWeight: 1,
  fillColor: "#4285F4",
  fillOpacity: 0.12,
  clickable: false,
};

export class SelfLocation {
  constructor(map, { watch = geoWatch } = {}) {
    this.map = map;
    this.watch = watch;
    this._unsub = null;
    this.marker = null;
    this.circle = null;
  }

  init() {
    // replayLast so a fix already cached by the geofence/seeker draws the dot at
    // once; this consumer only ever reads position, never gates on transitions.
    this._unsub = this.watch.subscribe((fix) => this._draw(fix), null, { replayLast: true });
  }

  destroy() {
    this._unsub?.();
    this._unsub = null;
    this._clear();
  }

  _draw(fix) {
    if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return;
    if (typeof window === "undefined" || !window.google?.maps) return;
    const pos = { lat: fix.lat, lng: fix.lng };
    if (!this.marker) {
      this.marker = new google.maps.Marker({
        position: pos,
        map: this.map,
        clickable: false,
        zIndex: 10_000, // above notes/stations/hider pin — it's "me"
        title: "Your location",
        icon: { path: google.maps.SymbolPath.CIRCLE, ...DOT_STYLE },
      });
    } else {
      this.marker.setPosition(pos);
    }
    // Accuracy ring: only meaningful when the device reports a radius.
    if (Number.isFinite(fix.accuracy) && fix.accuracy > 0) {
      if (!this.circle) {
        this.circle = new google.maps.Circle({ ...RING_STYLE, center: pos, radius: fix.accuracy, map: this.map });
      } else {
        this.circle.setCenter(pos);
        this.circle.setRadius(fix.accuracy);
      }
    }
  }

  _clear() {
    this.marker?.setMap(null);
    this.marker = null;
    this.circle?.setMap(null);
    this.circle = null;
  }
}
