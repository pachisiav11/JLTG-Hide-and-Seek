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
import { toast, contextMenu, promptText } from "./ui.js";
import { getPalette } from "./palette.js";
import { toggleStationElimination } from "./stations.js";
import { addNote } from "./notes.js";

// Marker sizing: small enough that a Mumbai-scale board with 40 stations doesn't
// look like a rash, but large enough to be a comfortable tap target on mobile.
// The eliminated variant is smaller AND hollow, so an "off" station reads at a
// glance as ruled-out (like a struck-through row in the panel).
const ACTIVE_ICON_SCALE = 5;
const ELIM_ICON_SCALE = 3.5;

// Phase 30 (req #2): long-press (touch) / right-click (desktop) opens the
// action chooser, mirroring the note-pin interaction in notes.js. A plain tap
// no longer does anything — it was too easy to eliminate a station by accident
// while just poking at the map.
const LONG_PRESS_MS = 500;

// Pure: the two actions a station's chooser offers. The toggle label reflects
// the station's current state so one sheet covers eliminate AND restore.
// Exported so the menu contents are unit-tested without a Google Maps instance.
export function stationLongPressActions(station) {
  const eliminated = !!station?.eliminated;
  return [
    { id: "note", label: "📝 Add note here" },
    { id: "toggle", label: eliminated ? "♻️ Restore station" : "❌ Eliminate station" },
  ];
}

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
    this._pressState = null;   // {timer, domEvent} while a long-press is pending
    this._dragHandle = null;   // map dragstart cancels a pending press (it's a pan)
  }

  init() {
    this._unsub = store.subscribe(() => this.render());
    // A pan mid-press is not a long-press — cancel, exactly as notes.js does.
    if (this.map?.addListener) {
      this._dragHandle = this.map.addListener("dragstart", () => this._cancelPress());
    }
  }
  destroy() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this._dragHandle?.remove?.();
    this._dragHandle = null;
    this._cancelPress();
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
        title: eliminated ? `${st.name} — eliminated (long-press for options)` : `${st.name} — long-press for options`,
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
      // Phase 30: no plain-tap handler — a single tap deliberately does
      // nothing. Long-press (touch) and right-click (desktop) both open the
      // action chooser; a pan or a short tap cancels the pending press.
      marker.addListener("mousedown", (e) => this._onDown(st, e));
      marker.addListener("mouseup", () => this._cancelPress());
      marker.addListener("rightclick", (e) => { this._cancelPress(); this._openChooser(st, e); });
      this.markers.push(marker);
    }
  }

  _onDown(st, e) {
    this._cancelPress();
    const domEvent = e?.domEvent || null;
    this._pressState = {
      domEvent,
      timer: setTimeout(() => {
        this._pressState = null;
        this._openChooser(st, e);
      }, LONG_PRESS_MS),
    };
  }
  _cancelPress() {
    if (this._pressState?.timer) clearTimeout(this._pressState.timer);
    this._pressState = null;
  }

  // Open the 2-option action sheet at the press location. Reuses the shared
  // contextMenu primitive so it matches the map's other right-click menus.
  _openChooser(st, e) {
    const dom = e?.domEvent || null;
    const x = Number.isFinite(dom?.clientX) ? dom.clientX : Math.round((typeof window !== "undefined" ? window.innerWidth : 320) / 2);
    const y = Number.isFinite(dom?.clientY) ? dom.clientY : Math.round((typeof window !== "undefined" ? window.innerHeight : 480) / 2);
    const actions = stationLongPressActions(st);
    contextMenu(x, y, actions.map((a) => ({
      label: a.label,
      onClick: () => (a.id === "note" ? this._addNoteAt(st) : this._toggle(st.id, st.name)),
    })));
  }

  async _addNoteAt(st) {
    const point = { lat: st.lat, lng: st.lng };
    const text = await promptText({
      title: "Note pin",
      label: `Drop a note at ${st.name} (${point.lat.toFixed(5)}, ${point.lng.toFixed(5)})`,
      placeholder: "e.g. photo rules this out / hider slipped a hint",
      cta: "Drop pin",
    });
    if (text === null) return;
    store.update((g) => {
      if (!Array.isArray(g.notes)) g.notes = [];
      addNote(g.notes, point, text);
    });
    store.saveNow();
    toast("Note pin added.");
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
