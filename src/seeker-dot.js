// Phase 37 (req #7b): the live seeker's position as a red dot on the hider's map.
//
// The live-share channel already streams the seeker's coordinates to the hider
// (§C5) and read them into a text pill; Phase 37 also draws them. The hider sees
// a red dot that jumps to the seeker's latest position on each ping (~60 s), so
// "how close are they" is a glance at the map, not mental arithmetic on the pill.
//
// LiveShare hands each new point (and a null on disconnect) to update(); this
// layer owns only the marker. Created on the first point, moved thereafter,
// removed on null — the mirror of the blue self-dot, in red.

const SEEKER_DOT_STYLE = {
  fillColor: "#ef4444",   // red — the pursuer
  fillOpacity: 1,
  strokeColor: "#ffffff",
  strokeWeight: 2,
  scale: 7,
};

export class SeekerDot {
  constructor(map) {
    this.map = map;
    this.marker = null;
  }

  // point: {lat,lng} to draw/move, or null/garbage to remove.
  update(point) {
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return this.remove();
    if (typeof window === "undefined" || !window.google?.maps) return;
    const pos = { lat: point.lat, lng: point.lng };
    if (!this.marker) {
      this.marker = new google.maps.Marker({
        position: pos,
        map: this.map,
        clickable: false,
        zIndex: 9_990, // above the board, below the hider's own self-dot
        title: "Seeker (live)",
        icon: { path: google.maps.SymbolPath.CIRCLE, ...SEEKER_DOT_STYLE },
      });
    } else {
      this.marker.setPosition(pos);
    }
  }

  remove() {
    this.marker?.setMap(null);
    this.marker = null;
  }
}
