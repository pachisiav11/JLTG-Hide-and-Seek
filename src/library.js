// Reusable custom library (Phase 9): user-defined Places categories and named
// location pins that persist across games — the same "define once, reuse
// everywhere" model as the zone library (guide §4). This is the long-term fix for
// regional data gaps: a group that plays repeatedly in one city can patch a missing
// category (or drop the exact pins they care about) once and reuse it every game.
//
// - Custom categories { id, label, type?, keyword?, radius } feed the same Places
//   search the built-in cards use, so they slot into Matching (nearest), Measuring
//   (points) and Tentacles (fixed radius) with no special-casing downstream.
// - Custom pins { id, name, lat, lng } are the exact [{lat,lng,name}] shape the
//   manual "place my own" flows already consume, so they can seed those flows.
//
// Reference: gelbh's SessionCustomCategory / SessionCustomLocationPin.
import * as db from "./db.js";
import { openSheet, toast, escapeHtml, promptText } from "./ui.js";

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export class Library {
  constructor(map, layers) {
    this.map = map;
    this.layers = layers; // for map-tap point picking when adding a pin
  }

  // ---- Data access ----
  getCategories() { return db.getAll("categories"); }
  getPins() { return db.getAll("pins"); }

  saveCategory(cat) {
    const rec = { id: cat.id || uid("cat"), label: cat.label, type: cat.type || "", keyword: cat.keyword || "", radius: cat.radius || 2000 };
    return db.put("categories", rec).then(() => rec);
  }
  deleteCategory(id) { return db.del("categories", id); }

  savePin(pin) {
    const rec = { id: pin.id || uid("pin"), name: pin.name, lat: pin.lat, lng: pin.lng };
    return db.put("pins", rec).then(() => rec);
  }
  deletePin(id) { return db.del("pins", id); }

  // ---- Manager UI ----
  async openManager() {
    const [cats, pins] = await Promise.all([this.getCategories(), this.getPins()]);
    const catRows = cats.length
      ? cats.map((c) => `<li>
          <span class="li-name">${escapeHtml(c.label)} <span class="muted">· ${escapeHtml(c.type || c.keyword || "?")}${c.radius ? ` · ${c.radius >= 1000 ? c.radius / 1000 + " km" : c.radius + " m"}` : ""}</span></span>
          <button class="btn btn-ghost btn-sm" data-catdel="${c.id}">🗑</button>
        </li>`).join("")
      : `<li class="muted">No custom categories yet.</li>`;
    const pinRows = pins.length
      ? pins.map((p) => `<li>
          <span class="li-name">${escapeHtml(p.name)} <span class="muted">· ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</span></span>
          <span class="li-actions">
            <button class="btn btn-ghost btn-sm" data-pinshow="${p.id}">Show</button>
            <button class="btn btn-ghost btn-sm" data-pindel="${p.id}">🗑</button>
          </span>
        </li>`).join("")
      : `<li class="muted">No saved pins yet.</li>`;

    const s = openSheet({
      title: "Custom library",
      bodyHTML: `
        <p class="muted">Custom categories and pins are saved on this device and reusable across games. Categories appear in Matching / Measuring / Tentacles; pins can seed the “place my own” flows.</p>
        <h3 class="sub">Custom categories</h3>
        <ul class="list">${catRows}</ul>
        <div class="row"><button id="lib-addcat" class="btn btn-primary">➕ Add category</button></div>
        <h3 class="sub">Saved pins</h3>
        <ul class="list">${pinRows}</ul>
        <div class="row"><button id="lib-addpin" class="btn btn-primary">📌 Add pin (tap map)</button></div>`,
    });
    s.q("#lib-addcat").onclick = () => { s.close(); this._addCategory(); };
    s.q("#lib-addpin").onclick = () => { s.close(); this._addPin(); };
    s.qa("[data-catdel]").forEach((b) => (b.onclick = async () => { await this.deleteCategory(b.dataset.catdel); s.close(); this.openManager(); }));
    s.qa("[data-pindel]").forEach((b) => (b.onclick = async () => { await this.deletePin(b.dataset.pindel); s.close(); this.openManager(); }));
    s.qa("[data-pinshow]").forEach((b) => (b.onclick = () => {
      const p = pins.find((x) => x.id === b.dataset.pinshow);
      if (p) { this.map.panTo({ lat: p.lat, lng: p.lng }); new google.maps.Marker({ position: { lat: p.lat, lng: p.lng }, label: "📌", map: this.map }); s.close(); toast(`Showing “${p.name}”.`); }
    }));
  }

  _addCategory() {
    const s = openSheet({
      title: "Add custom category",
      bodyHTML: `
        <p class="muted">A Places category to search — a place <em>type</em> (e.g. <code>cafe</code>) and/or a <em>keyword</em> (e.g. “boba”). Radius applies when used as a Tentacles card.</p>
        <label class="fieldlbl">Label</label>
        <input id="c-label" class="field" placeholder="e.g. Boba shops" />
        <label class="fieldlbl">Places type (optional)</label>
        <input id="c-type" class="field" placeholder="e.g. cafe" autocapitalize="off" spellcheck="false" />
        <label class="fieldlbl">Keyword (optional)</label>
        <input id="c-keyword" class="field" placeholder="e.g. boba" />
        <label class="fieldlbl">Tentacles radius (metres)</label>
        <input id="c-radius" class="field" type="number" inputmode="numeric" value="2000" min="100" step="100" />
        <div class="sheet-actions">
          <button id="c-cancel" class="btn btn-ghost">Cancel</button>
          <button id="c-save" class="btn btn-primary">Save</button>
        </div>`,
    });
    s.q("#c-cancel").onclick = () => s.close();
    s.q("#c-save").onclick = async () => {
      const label = s.q("#c-label").value.trim();
      const type = s.q("#c-type").value.trim();
      const keyword = s.q("#c-keyword").value.trim();
      const radius = Math.max(100, parseInt(s.q("#c-radius").value, 10) || 2000);
      if (!label) { toast("Give the category a label."); return; }
      if (!type && !keyword) { toast("Add a Places type or a keyword."); return; }
      await this.saveCategory({ label, type, keyword, radius });
      s.close();
      toast(`Saved “${label}”.`);
      this.openManager();
    };
  }

  async _addPin() {
    if (!this.layers?.pick) { toast("Map isn’t ready."); return; }
    const pts = await this.layers.pick(1, "Tap the location to save as a pin.");
    if (!pts || !pts.length) return this.openManager();
    const p = pts[0];
    const name = await promptText({ title: "Name this pin", label: "Name", value: "", placeholder: "e.g. City Hall", cta: "Save" });
    if (name === null) return this.openManager();
    await this.savePin({ name: name || "Pin", lat: p.lat, lng: p.lng });
    toast("Pin saved.");
    this.openManager();
  }
}
