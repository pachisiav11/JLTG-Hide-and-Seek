// Phase 6 (A3): render the locked station set as tappable markers on the map, so
// eliminating a station is a one-tap action on the object itself instead of
// scrolling a list panel to find it.
//
// The playtest didn't formally file a "manual station elimination" pain — the
// off-app deductions (Q4 photo, ambient "past Dahisar") never made it into map
// state at all. This closes the gap on the map side: any station the seekers
// have reasoned out (a photo shows a building not near there, the ambient
// context rules it out) is now a two-second interaction on the map, not a
// panel-hunting exercise.
//
// The Stations panel (games.js) already carries the per-station eliminated
// flag + eliminatedBy tag introduced in Phase 4. This module is the map-side
// display + click handler for the same state — no new persistence, no new
// field, and the flag flows both ways (panel tick → marker dims; marker click
// → panel row shows crossed-out).

import * as store from "./store.js";
import { toast } from "./ui.js";
import { getPalette } from "./palette.js";
import { toggleStationElimination } from "./stations.js";

// Marker sizing: small enough that a Mumbai-scale board with 40 stations doesn't
// look like a rash, but large enough to be a comfortable tap target on mobile.
// The eliminated variant is smaller AND hollow, so an "off" station reads at a
// glance as ruled-out (like a struck-through row in the panel).
const ACTIVE_ICON_SCALE = 5;
const ELIM_ICON_SCALE = 3.5;

export class StationsLayer {
  constructor(map) {
    this.map = map;
    this.markers = [];
    this._unsub = null;
    // Cache the last-rendered list identity, so a store change that doesn't
    // touch stations (a zone edit, a step add) doesn't tear down and redraw
    // every marker. Rendering is cheap on 8 stations and expensive on 400.
    this._lastListRef = null;
    this._lastFlagsSig = null;
  }

  init() {
    this._unsub = store.subscribe(() => this.render());
  }
  destroy() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this._clear();
  }

  // A quick per-render change detector: list identity (a refetch replaces the
  // array) OR the pattern of (eliminated flags) — the two things that require a
  // redraw. Ignores everything else.
  _flagsSig(list) {
    let s = "";
    for (const st of list) s += st.eliminated ? "1" : "0";
    return s;
  }

  render() {
    const g = store.getCurrent();
    const list = g?.stations?.list;
    if (!list || !list.length) return this._clear();
    const flagsSig = this._flagsSig(list);
    if (list === this._lastListRef && flagsSig === this._lastFlagsSig) return;
    this._clear();
    this._lastListRef = list;
    this._lastFlagsSig = flagsSig;
    if (!window.google?.maps) return;
    const pal = getPalette();
    // Use palette colours that stand out against the mask/active fills already
    // on the map. Active = the palette's "active" outline; eliminated = the
    // mask's fill colour, so a struck-out station reads as part of the
    // eliminated ground.
    const activeColor = pal?.active || "#38bdf8";
    const elimColor = pal?.mask?.fillColor || "#020a0c";
    for (const st of list) {
      if (!Number.isFinite(st.lat) || !Number.isFinite(st.lng)) continue;
      const eliminated = !!st.eliminated;
      const marker = new google.maps.Marker({
        position: { lat: st.lat, lng: st.lng },
        map: this.map,
        title: eliminated ? `${st.name} — eliminated (tap to restore)` : `${st.name} — tap to eliminate`,
        zIndex: eliminated ? 3 : 5,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: eliminated ? ELIM_ICON_SCALE : ACTIVE_ICON_SCALE,
          fillColor: eliminated ? "#0b1220" : activeColor,
          fillOpacity: eliminated ? 0.35 : 0.9,
          strokeColor: eliminated ? elimColor : "#04252a",
          strokeWeight: eliminated ? 1 : 1.5,
        },
      });
      marker.addListener("click", () => this._toggle(st.id, st.name));
      this.markers.push(marker);
    }
  }

  _toggle(id, name) {
    let result = null;
    store.update((g) => {
      result = toggleStationElimination(g?.stations?.list, id);
      if (!result) return false;
    });
    if (!result) return;
    store.saveNow();
    toast(result.eliminated ? `${name} eliminated.` : `${name} restored.`);
  }

  _clear() {
    this.markers.forEach((m) => m.setMap(null));
    this.markers = [];
    this._lastListRef = null;
    this._lastFlagsSig = null;
  }
}
