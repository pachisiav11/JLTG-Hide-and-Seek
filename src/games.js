// Game history browser, settings, and import/export (guide §6.3, §7 screens 5–6).
import * as store from "./store.js";
import { DEFAULT_SETTINGS } from "./model.js";
import { openSheet, toast, escapeHtml, promptText } from "./ui.js";
import { getPaletteName, setPalette } from "./palette.js";

export class Games {
  constructor(zones, { boundaries = null, features = null, library = null } = {}) {
    this.zones = zones; // used to fit the map after opening a game
    this.boundaries = boundaries; // reference-boundary overlays (cleared on wipe)
    this.features = features; // transient map features (route/measure/transit)
    this.library = library; // reusable custom categories + pins (Phase 9)
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
          <button id="mn-clear" class="btn">🧹 Clear board</button>
          <button id="mn-history" class="btn">🗂 Game history</button>
          <button id="mn-library" class="btn">📌 Custom library</button>
          <button id="mn-rename" class="btn">✏️ Rename current</button>
          <button id="mn-dup" class="btn">⧉ Duplicate current</button>
          <button id="mn-export" class="btn">⬇️ Export current (JSON)</button>
          <button id="mn-import" class="btn">⬆️ Import game</button>
          <button id="mn-print" class="btn">🖨 Print / save map (PDF)</button>
          <button id="mn-settings" class="btn">⚙️ Settings</button>
        </div>`,
    });
    s.q("#mn-new").onclick = async () => { s.close(); await this.newGame(); };
    s.q("#mn-clear").onclick = () => { s.close(); this.clearBoard(); };
    s.q("#mn-history").onclick = () => { s.close(); this.openHistory(); };
    s.q("#mn-library").onclick = () => { s.close(); this.library ? this.library.openManager() : toast("Library unavailable."); };
    s.q("#mn-rename").onclick = () => { s.close(); this.rename(); };
    s.q("#mn-dup").onclick = async () => { s.close(); await this.duplicate(); };
    s.q("#mn-export").onclick = async () => { await this.exportCurrent(); };
    s.q("#mn-import").onclick = () => { s.close(); this.openImport(); };
    s.q("#mn-print").onclick = () => { s.close(); this.printMap(); };
    s.q("#mn-settings").onclick = () => { s.close(); this.openSettings(); };
  }

  // Print-ready export of the current map view (Phase 12). No new dependency —
  // a @media print stylesheet hides the app chrome (toolbar, banners, sheets) and
  // prints just the map with the still-possible area shaded; the browser's
  // print-to-PDF is the "save" path. A short delay lets the menu sheet finish
  // closing so it isn't captured.
  printMap() {
    toast("Opening print view… choose “Save as PDF” to export.", 3500);
    setTimeout(() => window.print(), 400);
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
      try {
        await store.openGame(b.dataset.open);
      } catch (e) {
        toast(e.message || "Couldn't open that game.");
        return;
      }
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
    const name = await promptText({ title: "New game", label: "Name", placeholder: "e.g. Sunday Singapore run", cta: "Create" });
    if (name === null) return;
    await store.newGame(name ? { name } : {});
    this.zones?.fitToArea();
    toast("New game created.");
  }

  // Wipe the current game's map content (zones, area, questions, hider) plus any
  // transient overlays, so a board restored from a previous session — e.g. a
  // stray thermometer left over from earlier play — can be blanked without
  // creating a new game. Keeps the game record (name/settings) and its history
  // of *other* saved games intact.
  clearBoard() {
    const s = openSheet({
      title: "Clear board?",
      bodyHTML: `
        <p class="muted">Remove all zones, questions and the hider from <strong>this</strong> game, and clear any route/measure/boundary overlays. This can't be undone. Other saved games are untouched.</p>
        <div class="sheet-actions">
          <button id="cb-cancel" class="btn btn-ghost">Cancel</button>
          <button id="cb-go" class="btn btn-primary">Clear board</button>
        </div>`,
    });
    s.q("#cb-cancel").onclick = () => s.close();
    s.q("#cb-go").onclick = async () => {
      await store.clearBoard();
      this.boundaries?.clear();
      this.features?.clearAll();
      s.close();
      toast("Board cleared.");
    };
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
    const pal = getPaletteName();
    const mapStyle = localStorage.getItem("jltg.mapStyle") || "roadmap";
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
        <h3 class="sub">Colour theme</h3>
        <p class="muted">Elimination state is shown through colour. Switch to a colour-blind-safe palette (applies instantly).</p>
        <div class="seg">
          ${radio("palette", "default", pal, "Default")}
          ${radio("palette", "cb", pal, "Colour-blind safe (Okabe-Ito)")}
        </div>
        <h3 class="sub">Map style</h3>
        <div class="seg">
          ${radio("mapStyle", "roadmap", mapStyle, "Map")}
          ${radio("mapStyle", "satellite", mapStyle, "Satellite")}
          ${radio("mapStyle", "dark", mapStyle, "Dark")}
        </div>
        <h3 class="sub">Question timer</h3>
        <p class="muted">Optional soft countdown shown when a question is asked. It never blocks anything.</p>
        <div class="seg">
          ${radio("questionTimer", "0", String(st.questionTimer || 0), "Off")}
          ${radio("questionTimer", "60", String(st.questionTimer || 0), "1 minute")}
          ${radio("questionTimer", "120", String(st.questionTimer || 0), "2 minutes")}
          ${radio("questionTimer", "300", String(st.questionTimer || 0), "5 minutes")}
        </div>
        <h3 class="sub">Computed-truth check</h3>
        <p class="muted">When the hider's centre is set, flag any manual answer that would remove the hider's own location (a double-check hint — it never changes your answer).</p>
        <div class="seg">
          ${radio("truthCheck", "off", st.truthCheck ? "on" : "off", "Off")}
          ${radio("truthCheck", "on", st.truthCheck ? "on" : "off", "On")}
        </div>
        <h3 class="sub">Region boundaries (advanced)</h3>
        <p class="muted">Optional vector <strong>Map ID</strong> with Data-driven styling enabled, for exact official Google boundaries (🌍 Region boundary). Leave blank to use approximate extents.</p>
        <input id="st-mapid" class="field" type="text" autocomplete="off" spellcheck="false" placeholder="Map ID (optional)" value="${escapeHtml(localStorage.getItem("jltg.mapId") || "")}" />

        <h3 class="sub">Help</h3>
        <div class="row">
          <button id="st-help" class="btn">📖 Instructions</button>
        </div>
        <div class="sheet-actions">
          <button id="st-cancel" class="btn btn-ghost">Cancel</button>
          <button id="st-save" class="btn btn-primary">Save</button>
        </div>`,
    });
    s.q("#st-help").onclick = () => { s.close(); this.openInstructions(); };
    // Palette applies live on selection (no re-fetch); Cancel restores the prior one.
    s.qa('input[name="palette"]').forEach((r) => (r.onchange = () => setPalette(r.value)));
    // Map style also applies live via the jltg:mapstyle event.
    const applyMapStyleLive = (v) => window.dispatchEvent(new CustomEvent("jltg:mapstyle", { detail: v }));
    s.qa('input[name="mapStyle"]').forEach((r) => (r.onchange = () => applyMapStyleLive(r.value)));
    s.q("#st-cancel").onclick = () => { setPalette(pal); applyMapStyleLive(mapStyle); s.close(); };
    s.q("#st-save").onclick = () => {
      const distanceMode = s.qa('input[name="distanceMode"]').find((r) => r.checked)?.value || "straight-line";
      const units = s.qa('input[name="units"]').find((r) => r.checked)?.value || "metric";
      const questionTimer = parseInt(s.qa('input[name="questionTimer"]').find((r) => r.checked)?.value || "0", 10);
      const truthCheck = (s.qa('input[name="truthCheck"]').find((r) => r.checked)?.value || "off") === "on";
      store.update((gg) => (gg.settings = { ...gg.settings, distanceMode, units, questionTimer, truthCheck }));
      // Palette was already applied live on change; persist the chosen one.
      setPalette(s.qa('input[name="palette"]').find((r) => r.checked)?.value || "default");
      // Persist the device-level map style (already applied live via the event).
      localStorage.setItem("jltg.mapStyle", s.qa('input[name="mapStyle"]').find((r) => r.checked)?.value || "roadmap");
      // Map ID lives on the device (localStorage), applied on next reload since
      // it is immutable once the map is created.
      const mapId = s.q("#st-mapid").value.trim();
      const prevMapId = localStorage.getItem("jltg.mapId") || "";
      let reload = false;
      if (mapId !== prevMapId) {
        if (mapId) localStorage.setItem("jltg.mapId", mapId);
        else localStorage.removeItem("jltg.mapId");
        reload = true;
      }
      s.close();
      toast(reload ? "Saved — reload to apply the Map ID." : "Settings saved.");
    };
  }

  // ---- Instructions / user guide ----
  openInstructions() {
    const s = openSheet({
      title: "How to play",
      bodyHTML: `
        <div class="guide">
          <p class="muted">A digital board for <em>Jet Lag: The Game</em> Hide &amp; Seek. Build a play area, then add the questions seekers ask to shade the map down to where the hider is.</p>

          <h3 class="sub">1 · Build the play area — 🗺️ Zones</h3>
          <ul>
            <li><strong>Region boundary</strong> — search a place (Singapore, Switzerland) to overlay its official Google boundary as a <em>reference</em>, then trace your own points along it with Draw.</li>
            <li><strong>Draw</strong> — tap points on the map, then Finish.</li>
            <li><strong>Import</strong> — paste GeoJSON or a <code>lat,lng</code> list.</li>
            <li>Add several — they combine into one play area. Saved zones go to your reusable library.</li>
          </ul>

          <h3 class="sub">2 · Ask questions — ❓ Questions</h3>
          <p class="muted">Each question shades out where the hider <em>isn't</em>. Green outline = still-possible area.</p>
          <ul>
            <li><strong>◎ Radar</strong> — “Within X of this point?” Tap a centre, set the radius, pick Yes/No.</li>
            <li><strong>🌡 Thermometer</strong> — moving A→B, hotter or colder? Tap A then B.</li>
            <li><strong>🧭 Matching</strong> — one of the game's 20 cards. Reveal the hider's value and the app keeps the matching region: nearest-place cards (airport, park, museum, …) partition automatically; transit line / street are drawn as lines; admin divisions & landmass are drawn regions; station-name-length groups nearest-station regions by letter count.</li>
            <li><strong>🐙 Tentacles</strong> — a fixed-radius card (2 km: museums, libraries, movie theaters, hospitals · 25 km: metro lines, zoos, aquariums, amusement parks). Pick the one the hider is closest to (keeps its cell within that radius), or “none in range” (shades everything within that radius of them all).</li>
            <li><strong>📐 Measuring</strong> — one of the game's 20 cards: reveal the hider's distance and within/beyond. Nearest-place cards buffer automatically; high-speed rail, coastline and borders are drawn as lines; a body of water is a drawn area; sea level is a drawn region (elevation has no map geometry).</li>
            <li><strong>🗺 Admin check</strong> — tap two points to compare their administrative divisions (neighbourhood → country), each marked ✓ same / ✗ different / – unknown. A reasoning aid; it doesn't shade the map.</li>
            <li><strong>Undo / Redo</strong>, toggle any question on/off, and ✏️ rename it to the real question asked.</li>
          </ul>
          <p class="muted">Add your own reusable <strong>Custom library</strong> (☰ menu): custom Places categories appear in Matching / Measuring / Tentacles, and saved pins can seed the “place my own” flows — handy for a city with thin map data.</p>

          <h3 class="sub">3 · The hider — 🎯 Hider</h3>
          <p class="muted">Set the hiding-zone centre and radius; everything outside the radius is shaded. The radius is per game.</p>

          <h3 class="sub">Map tools</h3>
          <ul>
            <li><strong>🧭 Route</strong> — directions from your location / a tapped or searched place.</li>
            <li><strong>🚆 Transit</strong> — toggle the transit layer.</li>
            <li><strong>📏 Measure</strong> — tap two points (drag to adjust) for distance + travel time.</li>
            <li><strong>⤢ Fit</strong> — recentre on your zones. Long-press the map for quick “Directions here”.</li>
          </ul>

          <h3 class="sub">Games &amp; saving</h3>
          <p class="muted">Everything autosaves on your device (☰ menu → history, rename, duplicate, export/import as JSON, or <strong>🖨 Print / save map (PDF)</strong>). Distance mode, units, colour theme, <strong>map style</strong> (Map / Satellite / Dark), an optional per-question <strong>timer</strong>, and a <strong>computed-truth check</strong> (flags a manual answer that would remove the hider's own location) all live in Settings.</p>

          <div class="sheet-actions">
            <button id="hlp-close" class="btn btn-primary">Got it</button>
          </div>
        </div>`,
    });
    s.q("#hlp-close").onclick = () => s.close();
  }
}
