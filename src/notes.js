// Phase 10 (§C1): map note pins.
//
// The playtest recorded a specific class of drop: off-app clues (Q4 "photo of a
// building", ambient "heard a train pass at 3:12", or the seekers' shared "we
// think they're near the mall") that never made it into the app. They lived in
// people's heads or a WhatsApp thread and were lost between rounds. A long-press
// on the map + a short free-text label captures each one with the SAME weight as
// a station elimination: visible, persistent, per-game.
//
// Not a fold step. A note doesn't eliminate anything — it's a marker. That
// keeps the elimination engine untouched and lets notes be added / edited /
// deleted freely.
//
// The interaction is long-press on touch, right-click on desktop. Google Maps
// exposes both: mousedown/mouseup are wired manually, and "rightclick" is a
// first-class event on maps.

import * as store from "./store.js";
import { openSheet, toast, escapeHtml, promptText } from "./ui.js";

// The long-press threshold, per platform convention (Android is ~500 ms). Kept
// short enough that a hider isn't left staring at the screen after a real tap.
const LONG_PRESS_MS = 500;
// If the touch moves more than this many pixels during the wait, treat it as a
// pan instead of a long-press — otherwise scrolling the map from an unlucky
// starting position triggers a note prompt.
const LONG_PRESS_MOVE_TOLERANCE_PX = 12;

function uid() {
  return `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// A pure helper so the "add a note" / "update a note" / "remove a note" mutations
// are testable without a Google Maps instance.
export function addNote(list, point, text, { at = Date.now(), id = uid() } = {}) {
  const entry = { id, point: { lat: point.lat, lng: point.lng }, text: String(text || ""), at };
  list.push(entry);
  return entry;
}
export function updateNote(list, id, text) {
  const e = list.find((n) => n.id === id);
  if (!e) return null;
  e.text = String(text || "");
  return e;
}
export function removeNote(list, id) {
  const i = list.findIndex((n) => n.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

export class Notes {
  constructor(map) {
    this.map = map;
    this.markers = new Map(); // id → google.maps.Marker
    this._pressState = null;
    this._unsub = null;
    this._rightClickHandle = null;
    this._downHandle = null;
    this._upHandle = null;
    this._dragHandle = null;
  }

  init() {
    if (this.map?.addListener) {
      this._rightClickHandle = this.map.addListener("rightclick", (e) => this._promptAt(e.latLng));
      this._downHandle = this.map.addListener("mousedown", (e) => this._onDown(e));
      this._upHandle = this.map.addListener("mouseup", () => this._onUp());
      this._dragHandle = this.map.addListener("dragstart", () => this._onUp());
    }
    this._unsub = store.subscribe(() => this.render());
    this.render();
  }
  destroy() {
    this._unsub?.();
    this._rightClickHandle?.remove?.();
    this._downHandle?.remove?.();
    this._upHandle?.remove?.();
    this._dragHandle?.remove?.();
    this._clearMarkers();
  }

  _onDown(e) {
    if (!e?.latLng) return;
    this._onUp(); // clear any prior timer
    const latLng = e.latLng;
    this._pressState = {
      latLng,
      timer: setTimeout(() => {
        this._pressState = null;
        this._promptAt(latLng);
      }, LONG_PRESS_MS),
    };
  }
  _onUp() {
    if (this._pressState?.timer) clearTimeout(this._pressState.timer);
    this._pressState = null;
  }

  async _promptAt(latLng) {
    const point = { lat: latLng.lat(), lng: latLng.lng() };
    const text = await promptText({
      title: "Note pin",
      label: `Drop a note at ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`,
      placeholder: "e.g. photo shows a mall / heard train 3:12",
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

  render() {
    const g = store.getCurrent();
    const notes = g?.notes || [];
    // Diff against current markers by id — a store change that didn't touch
    // notes should leave every marker in place (google.maps.Marker instances
    // are surprisingly expensive to create/destroy in a hot loop).
    const seen = new Set();
    for (const n of notes) {
      seen.add(n.id);
      const existing = this.markers.get(n.id);
      if (existing) {
        existing.setPosition(n.point);
        existing.setTitle(n.text || "(empty note)");
        continue;
      }
      if (!window.google?.maps) return;
      const marker = new google.maps.Marker({
        position: n.point,
        map: this.map,
        title: n.text || "(empty note)",
        zIndex: 6,
        label: { text: "!", color: "#04252a", fontWeight: "700" },
      });
      marker.addListener("click", () => this._openNoteSheet(n.id));
      this.markers.set(n.id, marker);
    }
    // Remove markers for notes that have been deleted from the store.
    for (const [id, marker] of this.markers) {
      if (seen.has(id)) continue;
      marker.setMap(null);
      this.markers.delete(id);
    }
  }

  _openNoteSheet(id) {
    const g = store.getCurrent();
    const n = g?.notes?.find((x) => x.id === id);
    if (!n) return;
    const s = openSheet({
      title: "Note",
      bodyHTML: `
        <p class="muted">Dropped ${new Date(n.at).toLocaleString()} at ${n.point.lat.toFixed(5)}, ${n.point.lng.toFixed(5)}.</p>
        <label class="fieldlbl">Note</label>
        <textarea id="n-text" class="field" rows="3">${escapeHtml(n.text || "")}</textarea>
        <div class="sheet-actions">
          <button id="n-delete" class="btn btn-ghost">🗑 Delete</button>
          <button id="n-save" class="btn btn-primary">Save</button>
        </div>`,
    });
    s.q("#n-save").onclick = () => {
      const text = s.q("#n-text").value;
      store.update((gg) => { updateNote(gg.notes || [], id, text); });
      store.saveNow();
      s.close();
      toast("Note updated.");
    };
    s.q("#n-delete").onclick = () => {
      store.update((gg) => { removeNote(gg.notes || [], id); });
      store.saveNow();
      s.close();
      toast("Note deleted.");
    };
  }

  _clearMarkers() {
    for (const [, m] of this.markers) m.setMap(null);
    this.markers.clear();
  }
}
