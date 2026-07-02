// Game history browser, settings, and import/export (guide §6.3, §7 screens 5–6).
import * as store from "./store.js";
import { DEFAULT_SETTINGS } from "./model.js";
import { openSheet, toast, escapeHtml, promptText } from "./ui.js";

export class Games {
  constructor(zones) {
    this.zones = zones; // used to fit the map after opening a game
  }

  // ---- Top menu ----
  openMenu() {
    const g = store.getCurrent();
    const s = openSheet({
      title: "Menu",
      bodyHTML: `
        <p class="muted">Current game: <strong>${escapeHtml(g?.name || "—")}</strong></p>
        <div class="menu-list">
          <button id="mn-new" class="btn">➕ New game</button>
          <button id="mn-history" class="btn">🗂 Game history</button>
          <button id="mn-rename" class="btn">✏️ Rename current</button>
          <button id="mn-dup" class="btn">⧉ Duplicate current</button>
          <button id="mn-export" class="btn">⬇️ Export current (JSON)</button>
          <button id="mn-import" class="btn">⬆️ Import game</button>
          <button id="mn-settings" class="btn">⚙️ Settings</button>
        </div>`,
    });
    s.q("#mn-new").onclick = async () => { s.close(); await this.newGame(); };
    s.q("#mn-history").onclick = () => { s.close(); this.openHistory(); };
    s.q("#mn-rename").onclick = () => { s.close(); this.rename(); };
    s.q("#mn-dup").onclick = async () => { s.close(); await this.duplicate(); };
    s.q("#mn-export").onclick = async () => { await this.exportCurrent(); };
    s.q("#mn-import").onclick = () => { s.close(); this.openImport(); };
    s.q("#mn-settings").onclick = () => { s.close(); this.openSettings(); };
  }

  // ---- History browser ----
  async openHistory() {
    const games = await store.listGames();
    const current = store.getCurrent();
    const rows = games.length
      ? games.map((g) => {
          const date = new Date(g.updatedAt || g.createdAt).toLocaleString();
          const zoneSummary = g.zones?.length ? `${g.zones.length} zone${g.zones.length === 1 ? "" : "s"}` : "no zones";
          const steps = g.history?.length ? ` · ${g.history.length} step${g.history.length === 1 ? "" : "s"}` : "";
          const isCur = g.id === current?.id;
          return `<li class="game-row">
            <div class="game-meta">
              <span class="li-name">${escapeHtml(g.name)}${isCur ? " ·(open)" : ""}</span>
              <span class="muted">${escapeHtml(date)} · ${zoneSummary}${steps}</span>
            </div>
            <div class="li-actions">
              <button class="btn btn-ghost btn-sm" data-open="${g.id}">Open</button>
              <button class="btn btn-ghost btn-sm" data-del="${g.id}">🗑</button>
            </div>
          </li>`;
        }).join("")
      : `<li class="muted">No saved games.</li>`;
    const s = openSheet({ title: "Game history", bodyHTML: `<ul class="list">${rows}</ul>` });
    s.qa("[data-open]").forEach((b) => (b.onclick = async () => {
      await store.openGame(b.dataset.open);
      this.zones?.fitToArea();
      s.close();
      toast("Game opened.");
    }));
    s.qa("[data-del]").forEach((b) => (b.onclick = async () => {
      await store.deleteGame(b.dataset.del);
      s.close();
      this.openHistory();
    }));
  }

  // ---- Actions ----
  async newGame() {
    const name = await promptText({ title: "New game", label: "Name", placeholder: "e.g. Sunday Mumbai run", cta: "Create" });
    if (name === null) return;
    await store.newGame(name ? { name } : {});
    this.zones?.fitToArea();
    toast("New game created.");
  }

  async rename() {
    const g = store.getCurrent();
    const name = await promptText({ title: "Rename game", label: "Name", value: g?.name || "", cta: "Rename" });
    if (name === null || !name) return;
    store.update((gg) => (gg.name = name));
    toast("Renamed.");
  }

  async duplicate() {
    const cur = store.getCurrent();
    if (!cur) return;
    const { id, ...rest } = structuredClone(cur);
    await store.newGame({ ...rest, name: `${cur.name} (copy)` });
    this.zones?.fitToArea();
    toast("Duplicated to a new game.");
  }

  async exportCurrent() {
    const cur = store.getCurrent();
    if (!cur) return;
    const json = await store.exportGame(cur.id);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(cur.name || "game").replace(/[^\w.-]+/g, "_")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Exported JSON.");
  }

  openImport() {
    const s = openSheet({
      title: "Import game",
      bodyHTML: `
        <p class="muted">Choose a JSON file or paste its contents.</p>
        <input id="im-file" class="field" type="file" accept="application/json,.json" />
        <label class="fieldlbl">…or paste JSON</label>
        <textarea id="im-text" class="field" rows="6" placeholder='{"id":"…","zones":[…]}'></textarea>
        <div class="sheet-actions">
          <button id="im-cancel" class="btn btn-ghost">Cancel</button>
          <button id="im-go" class="btn btn-primary">Import</button>
        </div>
        <p id="im-status" class="muted"></p>`,
    });
    const doImport = async (text) => {
      try {
        const g = await store.importGame(text);
        await store.openGame(g.id);
        this.zones?.fitToArea();
        s.close();
        toast("Game imported.");
      } catch (e) {
        s.q("#im-status").textContent = e.message;
      }
    };
    s.q("#im-file").onchange = async (e) => {
      const file = e.target.files?.[0];
      if (file) doImport(await file.text());
    };
    s.q("#im-cancel").onclick = () => s.close();
    s.q("#im-go").onclick = () => doImport(s.q("#im-text").value);
  }

  // ---- Settings ----
  openSettings() {
    const g = store.getCurrent();
    const st = { ...DEFAULT_SETTINGS, ...(g?.settings || {}) };
    const radio = (name, val, cur, label) =>
      `<label><input type="radio" name="${name}" value="${val}" ${cur === val ? "checked" : ""}/> ${label}</label>`;
    const s = openSheet({
      title: "Settings",
      bodyHTML: `
        <h3 class="sub">Distance mode</h3>
        <p class="muted">Used for travel time in Measure and directions.</p>
        <div class="seg">
          ${radio("distanceMode", "straight-line", st.distanceMode, "Straight-line")}
          ${radio("distanceMode", "walking", st.distanceMode, "Walking")}
          ${radio("distanceMode", "transit", st.distanceMode, "Transit")}
        </div>
        <h3 class="sub">Units</h3>
        <div class="seg">
          ${radio("units", "metric", st.units, "Metric (m / km)")}
          ${radio("units", "imperial", st.units, "Imperial (ft / mi)")}
        </div>
        <div class="sheet-actions">
          <button id="st-cancel" class="btn btn-ghost">Cancel</button>
          <button id="st-save" class="btn btn-primary">Save</button>
        </div>`,
    });
    s.q("#st-cancel").onclick = () => s.close();
    s.q("#st-save").onclick = () => {
      const distanceMode = s.qa('input[name="distanceMode"]').find((r) => r.checked)?.value || "straight-line";
      const units = s.qa('input[name="units"]').find((r) => r.checked)?.value || "metric";
      store.update((gg) => (gg.settings = { ...gg.settings, distanceMode, units }));
      s.close();
      toast("Settings saved.");
    };
  }
}
