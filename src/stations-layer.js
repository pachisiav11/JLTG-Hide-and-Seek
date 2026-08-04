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
import { zoneRenderGeometry, zoneDiagnosis } from "./hiding-zones.js";
import { computeElimination } from "./tools.js";
import { geojsonToPathGroups } from "./geo.js";
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
export function stationLongPressActions(station, { hasZone = false } = {}) {
  const eliminated = !!station?.eliminated;
  const actions = [
    { id: "note", label: "📝 Add note here" },
    { id: "toggle", label: eliminated ? "♻️ Restore station" : "❌ Eliminate station" },
  ];
  // v2 Phase 3 (item N). Only offered when the board HAS a hiding radius: with no zone the
  // drill-down reduces to "is this point shaded", which the map already shows.
  if (hasZone) actions.push({ id: "zone", label: "🔎 What survives here?" });
  return actions;
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
    this._lastZoneSig = null;
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

  // v2 Phase 3 (item M). The zone overlay depends on two SETTINGS as well as the list, and
  // neither is part of `_flagsSig`. Without them in the signature, changing the hiding radius
  // or the render style leaves the previous overlay on the map — the redraw is skipped
  // because the station list itself did not change.
  _zoneSig(g) {
    return `${g?.settings?.hidingRadiusM || 0}|${g?.settings?.zoneStyle || "zones"}`;
  }

  render() {
    const g = store.getCurrent();
    const list = g?.stations?.list;
    if (!list || !list.length) return this._clear();
    const flagsSig = this._flagsSig(list);
    const zoneSig = this._zoneSig(g);
    if (list === this._lastListRef && flagsSig === this._lastFlagsSig && zoneSig === this._lastZoneSig) return;
    this._clear();
    this._lastListRef = list;
    this._lastFlagsSig = flagsSig;
    this._lastZoneSig = zoneSig;
    if (!window.google?.maps) return;
    this._renderZones(g, list);
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

  // v2 Phase 3, item M — draw the surviving hiding zones.
  //
  // Only stations that still have surviving zone area are drawn. A zone is the ground the
  // hider could actually be standing on, so drawing an eliminated one invites the seeker to
  // search somewhere the board has already ruled out.
  //
  // Four styles, because one does not fit every board:
  //   zones      — a circle each. Most informative, unreadable past ~40 overlapping stations.
  //   stations   — points only. What the layer did before this existed.
  //   no-overlap — the merged silhouette. On a dense board this is the only readable option
  //                and it is also the honest one: separate circles imply more distinct places
  //                than actually exist where they overlap.
  //   no-display — nothing. The station list still updates; the map stays clean.
  //
  // Zones are non-clickable and sit BELOW the station markers, so the existing long-press
  // interaction on a marker is unaffected.
  _renderZones(g, list) {
    const radiusM = g?.settings?.hidingRadiusM || 0;
    const style = g?.settings?.zoneStyle || "zones";
    if (!radiusM || style === "no-display" || style === "stations") return;

    // Hand-eliminated stations and zones the questions have ruled out are both gone.
    const live = list.filter((st) => !st.eliminated);
    if (!live.length) return;

    const pal = getPalette();
    const colour = pal?.active || "#38bdf8";
    const base = {
      strokeColor: colour, strokeOpacity: 0.55, strokeWeight: 1,
      fillColor: colour, fillOpacity: 0.10,
      clickable: false, zIndex: 2, map: this.map,
    };

    let geom;
    try { geom = zoneRenderGeometry(live, radiusM, style); }
    catch (e) { console.warn("zone render failed", e); return; }

    // A failed union must degrade to circles rather than blanking the overlay — the
    // silhouette is a readability aid, and losing it should not lose the information.
    const rings = style === "no-overlap" && geom.union
      ? geojsonToPathGroups(geom.union.geometry || geom.union)
      : geom.circles.map((c) => geojsonToPathGroups(c.zone.geometry)).flat();

    for (const paths of rings) {
      this.markers.push(new google.maps.Polygon({ ...base, paths }));
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
    const radiusM = store.getCurrent()?.settings?.hidingRadiusM || 0;
    const actions = stationLongPressActions(st, { hasZone: radiusM > 0 });
    contextMenu(x, y, actions.map((a) => ({
      label: a.label,
      onClick: () => {
        if (a.id === "note") return this._addNoteAt(st);
        if (a.id === "zone") return this._explainZone(st, radiusM);
        return this._toggle(st.id, st.name);
      },
    })));
  }

  // v2 Phase 3, item N — "if the hider is at THIS station, what does the board say?"
  //
  // The question a seeker actually asks late in a game, when the shading has stopped being
  // the useful representation and the real decision is which of six remaining stations to
  // drive to. The valuable half is the list of questions ruling the zone out: a zone can be
  // eliminated by the COMBINATION of two questions while neither does it alone, and the map
  // cannot show that. Naming them tells the seeker which answer to re-check when a station
  // they were confident about disappears.
  async _explainZone(st, radiusM) {
    const g = store.getCurrent();
    if (!g?.gameArea) return toast("Draw a play area first — there is nothing to measure a zone against.");
    let d;
    try {
      d = zoneDiagnosis(g.gameArea, g.history || [], st, radiusM, (step) => computeElimination(step, g.gameArea).eliminated);
    } catch (e) {
      console.warn("zone diagnosis failed", e);
      return toast("Couldn't work out what's left of this zone.");
    }
    if (!d) return toast("Couldn't work out what's left of this zone.");

    if (d.fraction === null) return toast(`${st.name}: this zone lies outside the play area.`);
    if (!d.survives) {
      const why = d.culprits.length
        ? ` Ruled out by ${d.culprits.length} question${d.culprits.length === 1 ? "" : "s"} (${d.culprits.map((c) => c.tool).join(", ")}).`
        : "";
      return toast(`${st.name}: nothing of this zone survives.${why}`);
    }
    const pct = Math.round(d.fraction * 100);
    const km2 = (d.survivingAreaM2 / 1e6).toFixed(2);
    const why = d.culprits.length
      ? ` ${d.culprits.length} question${d.culprits.length === 1 ? " has" : "s have"} cut into it (${d.culprits.map((c) => c.tool).join(", ")}).`
      : " No question has touched it.";
    toast(`${st.name}: ${pct}% of its zone survives (${km2} km²).${why}`);
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
