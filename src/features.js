// Native Google Maps features surfaced in-app (guide §7):
//  - Transit layer toggle
//  - "Directions here" on long-press (transit / walking, via Directions API)
//  - Distance between two taps (straight-line + walking time via Distance Matrix)
import { contextMenu, toast, formatDistance } from "./ui.js";
import * as store from "./store.js";

export class MapFeatures {
  constructor(map) {
    this.map = map;
    this.transit = null;
    this.dir = { service: null, renderer: null };
    this.matrix = null;
    this.measure = { active: false, pts: [], markers: [], line: null };
  }

  async init() {
    const routes = await google.maps.importLibrary("routes");
    this.dir.service = new routes.DirectionsService();
    this.dir.renderer = new routes.DirectionsRenderer({
      suppressMarkers: false,
      polylineOptions: { strokeColor: "#38bdf8", strokeWeight: 5, strokeOpacity: 0.9 },
    });
    this.matrix = new routes.DistanceMatrixService();

    // Map click — used only by measure mode.
    this.map.addListener("click", (e) => this._onClick(e.latLng));
    // Long-press / right-click → context menu with location actions.
    this.map.addListener("contextmenu", (e) => this._onContextMenu(e));
  }

  // ---- Transit layer ----
  toggleTransit() {
    if (!this.transit) this.transit = new google.maps.TransitLayer();
    const on = this.transit.getMap() == null;
    this.transit.setMap(on ? this.map : null);
    toast(on ? "Transit layer on" : "Transit layer off");
    return on;
  }
  isTransitOn() {
    return !!this.transit && this.transit.getMap() != null;
  }

  // ---- Directions here ----
  _onContextMenu(e) {
    const latLng = e.latLng;
    const dom = e.domEvent || {};
    const x = dom.clientX ?? window.innerWidth / 2;
    const y = dom.clientY ?? window.innerHeight / 2;
    contextMenu(x, y, [
      { label: "🚆 Directions here (transit)", onClick: () => this.directionsTo(latLng, google.maps.TravelMode.TRANSIT) },
      { label: "🚶 Directions here (walking)", onClick: () => this.directionsTo(latLng, google.maps.TravelMode.WALKING) },
      { label: "✖ Clear directions", onClick: () => this.clearDirections() },
    ]);
  }

  async directionsTo(destination, travelMode) {
    const origin = await this._getOrigin();
    if (!origin) {
      toast("Location unavailable — allow location access to get directions.");
      return;
    }
    this.dir.renderer.setMap(this.map);
    this.dir.service.route({ origin, destination, travelMode }, (res, status) => {
      if (status === "OK") {
        this.dir.renderer.setDirections(res);
        const leg = res.routes[0].legs[0];
        toast(`${leg.distance.text} · ${leg.duration.text}`, 5000);
      } else {
        toast(`Directions failed: ${status}`);
      }
    });
  }

  clearDirections() {
    this.dir.renderer.setMap(null);
    this.dir.renderer.setDirections({ routes: [] });
  }

  _getOrigin() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { timeout: 8000, maximumAge: 30000 }
      );
    });
  }

  // ---- Measure (distance between two taps) ----
  toggleMeasure() {
    this.measure.active = !this.measure.active;
    if (!this.measure.active) this._clearMeasure();
    else toast("Measure: tap two points on the map.");
    return this.measure.active;
  }

  _onClick(latLng) {
    if (!this.measure.active) return;
    if (this.measure.pts.length >= 2) this._clearMeasure();
    this.measure.pts.push(latLng);
    this.measure.markers.push(
      new google.maps.Marker({ position: latLng, map: this.map, label: `${this.measure.pts.length}` })
    );
    if (this.measure.pts.length === 2) this._computeMeasure();
  }

  _computeMeasure() {
    const [a, b] = this.measure.pts;
    this.measure.line = new google.maps.Polyline({
      path: [a, b],
      geodesic: true,
      strokeColor: "#f2c14e",
      strokeWeight: 3,
      map: this.map,
    });
    const meters = google.maps.geometry.spherical.computeDistanceBetween(a, b);
    const units = store.getCurrent()?.settings?.units || "metric";
    const straight = formatDistance(meters, units);
    const mode = store.getCurrent()?.settings?.distanceMode || "straight-line";
    if (mode === "straight-line") {
      toast(`Straight line: ${straight}`, 6000);
      return;
    }
    const travelMode = mode === "transit" ? google.maps.TravelMode.TRANSIT : google.maps.TravelMode.WALKING;
    toast(`Straight line: ${straight} · fetching ${mode} time…`, 6000);
    this.matrix.getDistanceMatrix(
      { origins: [a], destinations: [b], travelMode },
      (res, status) => {
        const el = res?.rows?.[0]?.elements?.[0];
        if (status === "OK" && el?.status === "OK") {
          toast(`Straight line: ${straight} · ${mode}: ${el.distance.text}, ${el.duration.text}`, 7000);
        }
      }
    );
  }

  _clearMeasure() {
    this.measure.markers.forEach((m) => m.setMap(null));
    this.measure.line?.setMap(null);
    this.measure = { active: this.measure.active, pts: [], markers: [], line: null };
  }
}
