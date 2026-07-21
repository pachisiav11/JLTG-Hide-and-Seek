// Game history browser, settings, and import/export (guide §6.3, §7 screens 5–6).
import * as store from "./store.js";
import { DEFAULT_SETTINGS } from "./model.js";
import { openSheet, toast, escapeHtml, promptText } from "./ui.js";
import { getPaletteName, setPalette } from "./palette.js";
import { sourceStationsForGame, eliminateStationsOnLine, restoreStationsOnLine, orderStationsAlongLine, eliminateStationsInRange, restoreStationsInRange } from "./stations.js";
import { parseSeekerLocation, formatLocationForClipboard } from "./ingest.js";
import { LiveShare, generateSessionCode } from "./live-share.js";
import * as places from "./places.js";

export class Games {
  constructor(zones, { boundaries = null, features = null, library = null, map = null, lines = null, liveShare = null } = {}) {
    this.zones = zones; // used to fit the map after opening a game
    this.boundaries = boundaries; // reference-boundary overlays (cleared on wipe)
    this.features = features; // transient map features (route/measure/transit)
    this.library = library; // reusable custom categories + pins (Phase 9)
    this.map = map; // used for Places-sourced stations (Places needs a map ref)
    this.lines = lines; // rail line data — needed for A4 "eliminate this line's stations"
    this.liveShare = liveShare; // §C5 live seeker↔hider location channel
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
          <button id="mn-stations" class="btn">🚉 Stations</button>
          <button id="mn-seeker" class="btn">📍 Seeker location (paste)</button>
          <button id="mn-copyloc" class="btn">📋 Copy MY location</button>
          <button id="mn-liveshare" class="btn">📡 Live location share (session)</button>
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
    s.q("#mn-stations").onclick = () => { s.close(); this.openStations(); };
    s.q("#mn-seeker").onclick = () => { s.close(); this.openSeekerLocation(); };
    s.q("#mn-copyloc").onclick = () => { s.close(); this.copyMyLocation(); };
    s.q("#mn-liveshare").onclick = () => { s.close(); this.openLiveShare(); };
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

  // Wipe the current game's map content (zones, area, questions) plus any
  // transient overlays, so a board restored from a previous session — e.g. a
  // stray thermometer left over from earlier play — can be blanked without
  // creating a new game. Keeps the game record (name/settings) and its history
  // of *other* saved games intact.
  clearBoard() {
    const s = openSheet({
      title: "Clear board?",
      bodyHTML: `
        <p class="muted">Remove all zones, questions and the hider zone from <strong>this</strong> game, and clear any route/measure/boundary overlays. This can't be undone. Other saved games are untouched.</p>
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

  // ---- Stations (locked station set — PLAYTEST_IDEAS §0) ----
  //
  // A game-owned collection of the stations on this board. Sourced from OSM or Google
  // Places at the user's choice — the two return overlapping but not identical sets and
  // the picker exposes both rather than silently fusing them. Once confirmed, the list
  // is the authoritative station domain for the rest of the game.
  async openStations() {
    const g = store.getCurrent();
    if (!g) return;
    const bbox = g.gameArea;
    const st = g.stations || { list: [], source: null, confirmedAt: null };
    if (!bbox) {
      return this._stationsSheet(g, {
        info: "Draw a game area first — stations are sourced for the board.",
        actions: false,
      });
    }
    this._stationsSheet(g);
  }

  _stationsSheet(g, { info = null, actions = true } = {}) {
    const st = g.stations || { list: [], source: null, confirmedAt: null };
    const rows = st.list.length
      ? st.list.map((s) => `
          <li class="station-row" data-id="${escapeHtml(s.id)}">
            <label class="station-keep">
              <input type="checkbox" class="st-elim" data-id="${escapeHtml(s.id)}" ${s.eliminated ? "checked" : ""}/>
              <span class="${s.eliminated ? "station-out" : ""}">${escapeHtml(s.name)}</span>
            </label>
            <span class="muted">${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}</span>
            <button class="btn btn-ghost btn-sm st-drop" data-id="${escapeHtml(s.id)}" title="Remove from set">🗑</button>
          </li>`).join("")
      : `<li class="muted">No stations yet — pick a source below and materialise the list.</li>`;
    const meta = st.confirmedAt
      ? `<p class="muted">Locked in from <strong>${st.source === "osm" ? "OpenStreetMap" : st.source === "places" ? "Google Places" : "unknown"}</strong> on ${new Date(st.confirmedAt).toLocaleString()} — ${st.list.length} station${st.list.length === 1 ? "" : "s"}.</p>`
      : st.source
      ? `<p class="muted">Sourced from ${st.source}, not yet confirmed — ${st.list.length} station${st.list.length === 1 ? "" : "s"} in draft.</p>`
      : `<p class="muted">No station set for this game yet. Pick a source to materialise one.</p>`;

    // A4: bulk-eliminate all stations on a chosen rail line. Only shown once BOTH
    // a station set exists AND rail lines have been loaded (Rail panel opened), so
    // we don't offer an action that can only fail. Each line row shows the count
    // of currently-eliminated stations tagged with THIS line's key so the "Restore"
    // button surface honestly reflects what it will do.
    const lineGroups = (this.lines?.lineGroups?.() || []).filter((l) => l.paths?.length);
    const lineTagCount = (key) => st.list.filter((s) => s.eliminatedBy === `line:${key}`).length;
    const lineBlock = actions && st.list.length && lineGroups.length ? `
      <h3 class="sub">Eliminate by line</h3>
      <p class="muted">Playtest Q1: "not the blue line". Marks every station within 100 m of the line as eliminated; Restore undoes only that line's marks (manual eliminations stay).</p>
      <ul class="list station-line-list">
        ${lineGroups.map((l) => {
          const marked = lineTagCount(l.key);
          return `<li class="station-line-row">
            <span>${escapeHtml(l.label)}</span>
            <span class="muted">${marked ? `${marked} marked` : "—"}</span>
            <button class="btn btn-ghost btn-sm sl-elim" data-key="${escapeHtml(l.key)}">Eliminate</button>
            <button class="btn btn-ghost btn-sm sl-range" data-key="${escapeHtml(l.key)}">Range…</button>
            <button class="btn btn-ghost btn-sm sl-restore" data-key="${escapeHtml(l.key)}" ${marked ? "" : "disabled"}>Restore</button>
          </li>`;
        }).join("")}
      </ul>
    ` : "";
    const lineHint = actions && st.list.length && !lineGroups.length
      ? `<p class="muted"><em>Open the 🚄 Rail panel first to enable per-line elimination.</em></p>`
      : "";

    const s = openSheet({
      title: "Stations",
      bodyHTML: `
        <p class="muted">The stations on this board. Locked in once — the rest of the game (line elimination, range elimination, "N of Y" counters) refers to this set.</p>
        ${info ? `<p class="warn-note">${escapeHtml(info)}</p>` : ""}
        ${meta}
        ${actions ? `
        <div class="row">
          <button id="st-osm" class="btn">🌍 Source from OSM</button>
          <button id="st-places" class="btn">🅶 Source from Google Places</button>
        </div>
        <ul class="list station-list">${rows}</ul>
        ${lineBlock}
        ${lineHint}
        <div class="sheet-actions">
          <button id="st-confirm" class="btn btn-primary" ${st.list.length && !st.confirmedAt ? "" : "disabled"}>Lock in this set</button>
          <button id="st-clear" class="btn btn-ghost" ${st.list.length ? "" : "disabled"}>Clear set</button>
        </div>` : ""}
      `,
    });
    if (!actions) return s;

    const refresh = () => { s.close(); this._stationsSheet(store.getCurrent()); };

    const materialise = async (source) => {
      const btn = s.q(source === "osm" ? "#st-osm" : "#st-places");
      btn.disabled = true;
      btn.textContent = "Loading…";
      try {
        const cur = store.getCurrent();
        const out = await sourceStationsForGame(cur, {
          source,
          placesImpl: source === "places" ? { searchCategory: (opts) => places.searchCategory(this.map, opts) } : null,
        });
        // Preserve prior per-station edits (eliminated flag, notes) by id: refetching
        // OSM shouldn't undo a manual elimination the seeker already recorded.
        const priorById = new Map((cur.stations?.list || []).map((s) => [s.id, s]));
        const list = out.stations.map((s) => {
          const prior = priorById.get(s.id);
          return prior ? { ...s, eliminated: prior.eliminated || false, note: prior.note || null } : s;
        });
        store.update((gg) => {
          gg.stations = {
            source,
            bbox: out.bbox,
            confirmedAt: null, // materialising resets the confirmation — user must re-lock
            list,
          };
        });
        store.saveNow();
        toast(`${list.length} station${list.length === 1 ? "" : "s"} from ${source === "osm" ? "OSM" : "Google Places"}.`);
      } catch (e) {
        console.warn("station source failed", e);
        toast(`Couldn't load stations — ${e.message}`);
        btn.disabled = false;
        btn.textContent = source === "osm" ? "🌍 Source from OSM" : "🅶 Source from Google Places";
        return;
      }
      refresh();
    };

    s.q("#st-osm").onclick = () => materialise("osm");
    s.q("#st-places").onclick = () => materialise("places");
    s.q("#st-confirm").onclick = () => {
      store.update((gg) => {
        if (!gg.stations) return false;
        gg.stations.confirmedAt = Date.now();
      });
      store.saveNow();
      toast("Station set locked in.");
      refresh();
    };
    s.q("#st-clear").onclick = () => {
      store.update((gg) => { gg.stations = { source: null, bbox: null, confirmedAt: null, list: [] }; });
      store.saveNow();
      toast("Station set cleared.");
      refresh();
    };
    for (const el of s.qa(".st-drop")) {
      el.onclick = () => {
        const id = el.dataset.id;
        store.update((gg) => {
          if (!gg.stations?.list) return false;
          gg.stations.list = gg.stations.list.filter((s) => s.id !== id);
          gg.stations.confirmedAt = null;
        });
        store.saveNow();
        refresh();
      };
    }
    for (const el of s.qa(".sl-elim")) {
      el.onclick = () => {
        const key = el.dataset.key;
        const line = lineGroups.find((l) => l.key === key);
        if (!line) return;
        let hits = 0;
        store.update((gg) => {
          if (!gg.stations?.list) return false;
          const { hitIds } = eliminateStationsOnLine(gg.stations.list, key, line.paths);
          hits = hitIds.length;
        });
        store.saveNow();
        toast(hits ? `${hits} station${hits === 1 ? "" : "s"} on ${line.label} marked eliminated.` : `No stations near ${line.label} on this board.`);
        refresh();
      };
    }
    for (const el of s.qa(".sl-range")) {
      el.onclick = () => {
        const key = el.dataset.key;
        const line = lineGroups.find((l) => l.key === key);
        if (!line) return;
        s.close();
        this._openRangeSheet(line);
      };
    }
    for (const el of s.qa(".sl-restore")) {
      el.onclick = () => {
        const key = el.dataset.key;
        const line = lineGroups.find((l) => l.key === key);
        let restored = 0;
        store.update((gg) => {
          if (!gg.stations?.list) return false;
          const { changed } = restoreStationsOnLine(gg.stations.list, key);
          restored = changed.length;
        });
        store.saveNow();
        toast(restored ? `${restored} station${restored === 1 ? "" : "s"} on ${line?.label || key} restored.` : `No line-tagged eliminations to restore.`);
        refresh();
      };
    }
    for (const el of s.qa(".st-elim")) {
      el.onchange = () => {
        const id = el.dataset.id;
        store.update((gg) => {
          const entry = gg.stations?.list?.find((s) => s.id === id);
          if (!entry) return false;
          entry.eliminated = el.checked;
          // Manual toggle wins over any line tag. Otherwise a station eliminated via
          // "Eliminate this line" then unchecked here would be silently re-eliminated
          // by a later "Restore this line", because the tag still matched.
          entry.eliminatedBy = el.checked ? "manual" : null;
        });
        // Toggling elimination doesn't invalidate the lock; only structural changes do.
      };
    }
    return s;
  }

  // ---- Range elimination on a line (A5 — playtest Q0 "not past Dahisar") ----
  //
  // A subsheet driven by orderStationsAlongLine. Two dropdowns pick From and To;
  // the seeker chooses whether to eliminate the range inclusively (a mid-line
  // block) or the OUTSIDE of it (the "past X" case — hider is between the two,
  // everything else is out). Restore un-flips only what this range tagged.
  _openRangeSheet(line) {
    const g = store.getCurrent();
    const list = g?.stations?.list || [];
    const ordered = orderStationsAlongLine(list, line.paths);
    if (!ordered.length) {
      toast(`No stations found on ${line.label}.`);
      return this._stationsSheet(g);
    }
    const rangeTag = `line:${line.key}:range`;
    const marked = list.filter((s) => s.eliminatedBy === rangeTag).length;
    const opts = ordered.map((s, i) => `<option value="${escapeHtml(s.id)}">${i + 1}. ${escapeHtml(s.name)}</option>`).join("");
    const s = openSheet({
      title: `Range on ${line.label}`,
      bodyHTML: `
        <p class="muted">Playtest Q0: <em>"not past Dahisar"</em>. Order along the line is approximated from the longest way — pick two endpoints, then eliminate the inside or the outside of that range.</p>
        <label class="fieldlbl">From</label>
        <select id="r-from" class="field">${opts}</select>
        <label class="fieldlbl">To</label>
        <select id="r-to" class="field">${opts}</select>
        <div class="row">
          <button id="r-inside" class="btn">Eliminate range (inclusive)</button>
          <button id="r-outside" class="btn btn-primary">Eliminate <em>outside</em> range</button>
        </div>
        <div class="row">
          <button id="r-restore" class="btn btn-ghost" ${marked ? "" : "disabled"}>Restore range (${marked} marked)</button>
          <button id="r-back" class="btn btn-ghost">Back to stations</button>
        </div>
      `,
    });
    // Preselect first + last so the "outside" default is the natural playtest
    // Q0 shape — "keep only stations 1..last, eliminate everything not between."
    s.q("#r-to").value = ordered[ordered.length - 1].id;

    const apply = (mode) => {
      const fromId = s.q("#r-from").value;
      const toId = s.q("#r-to").value;
      let n = 0;
      store.update((gg) => {
        const cur = gg?.stations?.list;
        if (!cur) return false;
        const curOrdered = orderStationsAlongLine(cur, line.paths);
        const { changed } = eliminateStationsInRange(curOrdered, fromId, toId, line.key, { mode });
        n = changed.length;
      });
      store.saveNow();
      toast(n ? `${n} station${n === 1 ? "" : "s"} on ${line.label} marked eliminated.` : `Nothing to eliminate for that range.`);
      s.close();
      this._stationsSheet(store.getCurrent());
    };
    s.q("#r-inside").onclick = () => apply("range");
    s.q("#r-outside").onclick = () => apply("outside");
    s.q("#r-restore").onclick = () => {
      let n = 0;
      store.update((gg) => {
        const cur = gg?.stations?.list;
        if (!cur) return false;
        const { changed } = restoreStationsInRange(cur, line.key);
        n = changed.length;
      });
      store.saveNow();
      toast(n ? `${n} station${n === 1 ? "" : "s"} restored.` : "Nothing to restore.");
      s.close();
      this._stationsSheet(store.getCurrent());
    };
    s.q("#r-back").onclick = () => { s.close(); this._stationsSheet(store.getCurrent()); };
  }

  // ---- Live seeker→hider location share (§C5) ----
  //
  // Two devices, one session code exchanged out-of-band (WhatsApp / verbal).
  // Seeker publishes GPS every ~60 s to the room; hider subscribes and gets a
  // notification when the seeker crosses the approach threshold near the
  // hiding zone. Transport is created lazily by loading the backend's
  // socket.io-client shim from `${OVERPASS_PROXY_URL}/socket.io/socket.io.js`
  // (same trick Phase 13 used). If the proxy is unset, the panel says so and
  // does nothing else — inert rather than a silent no-op.
  async openLiveShare() {
    const st = { ...DEFAULT_SETTINGS, ...(store.getCurrent()?.settings || {}) };
    const proxy = window.JLTG_CONFIG?.MULTIPLAYER_URL || window.JLTG_CONFIG?.OVERPASS_PROXY_URL || "";
    const shareState = this.liveShare;
    const s = openSheet({
      title: "Live location share",
      bodyHTML: `
        <p class="muted">A narrow one-way channel: the SEEKER's device streams its GPS to the HIDER's device (no game state). Exchange the session code out of band.</p>
        ${!proxy ? `<p class="warn-note">No relay URL is configured (OVERPASS_PROXY_URL / MULTIPLAYER_URL). The share won't reach the other device — set it in config.js or in the deployment env vars.</p>` : ""}
        <label class="fieldlbl">Session code</label>
        <div class="row">
          <input id="ls-code" class="field" type="text" spellcheck="false" autocomplete="off" value="${escapeHtml(shareState?.code || localStorage.getItem("jltg.liveShareCode") || "")}" placeholder="e.g. m5x7pq"/>
          <button id="ls-gen" class="btn">Generate</button>
        </div>
        <label class="fieldlbl">Approach threshold (hider only) — alert when seeker within</label>
        <div class="seg">
          <label><input type="radio" name="ls-th" value="0" ${st.approachThresholdM === 0 ? "checked" : ""}/> Off (pin only)</label>
          <label><input type="radio" name="ls-th" value="500" ${st.approachThresholdM === 500 ? "checked" : ""}/> 500 m</label>
          <label><input type="radio" name="ls-th" value="1000" ${st.approachThresholdM === 1000 ? "checked" : ""}/> 1 km</label>
          <label><input type="radio" name="ls-th" value="2000" ${!st.approachThresholdM || st.approachThresholdM === 2000 ? "checked" : ""}/> 2 km</label>
          <label><input type="radio" name="ls-th" value="5000" ${st.approachThresholdM === 5000 ? "checked" : ""}/> 5 km</label>
        </div>
        <p class="muted">Status: <strong>${shareState?.role ? `${shareState.role} in "${escapeHtml(shareState.code || "")}"` : "not connected"}</strong></p>
        <div class="row">
          <button id="ls-seeker" class="btn">📡 Share as SEEKER</button>
          <button id="ls-hider" class="btn">🎯 Receive as HIDER</button>
        </div>
        <div class="sheet-actions">
          <button id="ls-stop" class="btn btn-ghost">Stop / disconnect</button>
          <button id="ls-close" class="btn">Close</button>
        </div>`,
    });
    s.q("#ls-gen").onclick = () => { s.q("#ls-code").value = generateSessionCode(); };
    const saveThreshold = () => {
      const v = parseInt(s.qa('input[name="ls-th"]').find((r) => r.checked)?.value || "2000", 10);
      store.update((gg) => (gg.settings = { ...gg.settings, approachThresholdM: v }));
    };
    const connect = async (role) => {
      const code = s.q("#ls-code").value.trim().toLowerCase();
      if (!/^[a-z0-9-]{3,32}$/.test(code)) return toast("Enter a 3-32 char session code (letters, digits, hyphens).");
      localStorage.setItem("jltg.liveShareCode", code);
      saveThreshold();
      if (!proxy) return toast("No relay URL configured — cannot connect.");
      if (!shareState) return toast("Live-share isn't initialised in this session.");
      // Lazy-load the transport now, once per app session. Reuses the pattern
      // Phase 13 documented in MULTIPLAYER_DESIGN.md: load the client shim
      // from the backend so we don't ship a socket.io-client dep in the SW.
      if (!shareState.transport) {
        try {
          await new Promise((resolve, reject) => {
            if (window.io) return resolve();
            const script = document.createElement("script");
            script.src = proxy.replace(/\/+$/, "") + "/socket.io/socket.io.js";
            script.onload = resolve;
            script.onerror = () => reject(new Error("failed to load socket.io client shim"));
            document.head.appendChild(script);
          });
          const sock = window.io(proxy);
          shareState.transport = sock; // Socket.IO client IS the EventEmitter API LiveShare expects
        } catch (e) {
          console.warn("live-share transport init failed", e);
          return toast(`Couldn't connect to relay — ${e.message}`);
        }
      }
      if (role === "seeker") shareState.startAsSeeker(code); else shareState.startAsHider(code);
      toast(`Live share: ${role} in "${code}"`);
      s.close();
    };
    s.q("#ls-seeker").onclick = () => connect("seeker");
    s.q("#ls-hider").onclick = () => connect("hider");
    s.q("#ls-stop").onclick = () => { shareState?.stop?.(); toast("Live share stopped."); s.close(); };
    s.q("#ls-close").onclick = () => { saveThreshold(); s.close(); };
  }

  // ---- Copy MY location (§C2) — the mirror of A2's paste intake ----
  //
  // The seeker has to type or paste their own coordinates into whatever chat
  // the group uses so the hider can then paste them into the app. That reverse
  // leg is the same friction as A2, one direction earlier. One tap on this
  // button reads the seeker's GPS, formats it in the exact shape A2 accepts
  // (§ src/ingest.js), and puts it on the clipboard.
  async copyMyLocation() {
    if (!navigator.geolocation) return toast("Geolocation not available.");
    const cur = await new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve(p),
        (err) => { toast(`Location unavailable — ${err.message || "allow access"}.`); resolve(null); },
        { enableHighAccuracy: true, timeout: 8000 },
      );
    });
    if (!cur) return;
    const text = formatLocationForClipboard(cur.coords.latitude, cur.coords.longitude);
    if (!text) return toast("Couldn't format the coordinates.");
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied: ${text}`);
    } catch (e) {
      // A user who blocked clipboard access still sees the number in the toast
      // so they can retype it — the failure surface at least gives them the
      // information the button was for.
      toast(`Copy blocked — coordinates: ${text}`);
    }
  }

  // ---- Seeker location paste (A2 — WhatsApp intake) ----
  //
  // Playtest 1's systemic pain 2: seekers shared their live location, radar
  // centres, and thermometer endpoints via WhatsApp; the hider transcribed each
  // one by hand, and the transcription is the miss (dropped digits, swapped
  // lat/lng, "we're two messages behind"). One paste box that accepts either
  // bare "lat, lng" or a Google Maps URL removes the transcription step.
  openSeekerLocation() {
    const g = store.getCurrent();
    const cur = g?.seekerLocation || null;
    const s = openSheet({
      title: "Seeker location",
      bodyHTML: `
        <p class="muted">Paste whatever the seeker sent: <em>lat, lng</em> ("19.15, 72.85"), a Google Maps URL, or WhatsApp's "share location" text. The app pulls the coordinates out.</p>
        ${cur ? `<p>Current: <strong>${cur.lat.toFixed(5)}, ${cur.lng.toFixed(5)}</strong> <span class="muted">(set ${new Date(cur.at).toLocaleTimeString()})</span></p>` : `<p class="muted">No seeker location set for this game yet.</p>`}
        <label class="fieldlbl">Paste</label>
        <textarea id="sl-input" class="field" rows="3" placeholder="19.15, 72.85 &#10;or https://maps.google.com/…?q=19.15,72.85"></textarea>
        <div class="row">
          <button id="sl-apply" class="btn btn-primary">Apply</button>
          <button id="sl-clear" class="btn btn-ghost" ${cur ? "" : "disabled"}>Clear</button>
        </div>
        <p id="sl-status" class="muted"></p>
        <p class="muted">Once set, the Radar and Thermometer setup sheets offer <em>Use seeker location</em> to snap the anchor to this point — no map-tap needed.</p>
      `,
    });
    s.q("#sl-apply").onclick = () => {
      const text = s.q("#sl-input").value;
      const parsed = parseSeekerLocation(text);
      if (!parsed) {
        s.q("#sl-status").textContent = "Couldn't read coordinates from that — try 'lat, lng' or a Google Maps URL.";
        return;
      }
      store.update((gg) => {
        gg.seekerLocation = { lat: parsed.lat, lng: parsed.lng, at: Date.now(), source: parsed.source };
      });
      store.saveNow();
      toast(`Seeker location set: ${parsed.lat.toFixed(5)}, ${parsed.lng.toFixed(5)}`);
      s.close();
    };
    s.q("#sl-clear").onclick = () => {
      store.update((gg) => (gg.seekerLocation = null));
      store.saveNow();
      toast("Seeker location cleared.");
      s.close();
    };
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
        <h3 class="sub">Hider geofence</h3>
        <p class="muted">While hiding, warn me when I'm this close to the edge of the Hider zone (or if I cross it). Requires notification permission; works while the app is open. Set to Off to disable.</p>
        <div class="seg">
          ${radio("geofenceMetres", "0", String(st.geofenceMetres || 0), "Off")}
          ${radio("geofenceMetres", "50", String(st.geofenceMetres || 0), "50 m")}
          ${radio("geofenceMetres", "100", String(st.geofenceMetres || 0), "100 m")}
          ${radio("geofenceMetres", "200", String(st.geofenceMetres || 0), "200 m")}
        </div>
        <p class="muted">Alert style (§C3): vibrate + tone reaches a phone in a pocket.</p>
        <div class="seg">
          ${radio("geofenceAlertStyle", "silent", st.geofenceAlertStyle || "vibrate-tone", "Silent (notification only)")}
          ${radio("geofenceAlertStyle", "vibrate", st.geofenceAlertStyle || "vibrate-tone", "Vibrate")}
          ${radio("geofenceAlertStyle", "vibrate-tone", st.geofenceAlertStyle || "vibrate-tone", "Vibrate + tone")}
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
      const geofenceMetres = parseInt(s.qa('input[name="geofenceMetres"]').find((r) => r.checked)?.value || "0", 10);
      const geofenceAlertStyle = s.qa('input[name="geofenceAlertStyle"]').find((r) => r.checked)?.value || "vibrate-tone";
      store.update((gg) => (gg.settings = { ...gg.settings, distanceMode, units, questionTimer, geofenceMetres, geofenceAlertStyle }));
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

          <h3 class="sub">Map tools</h3>
          <ul>
            <li><strong>🎯 Hider</strong> — once you've narrowed down where the hider is, drop a centre point and a radius; everything outside it is shaded, leaving the suspected area clear. Per game; a marker only (no radius) is fine too.</li>
            <li><strong>🧭 Route</strong> — directions from your location / a tapped or searched place.</li>
            <li><strong>🚆 Transit</strong> — toggle the transit layer.</li>
            <li><strong>📏 Measure</strong> — tap two points (drag to adjust) for distance + travel time.</li>
            <li><strong>⤢ Fit</strong> — recentre on your zones. Long-press the map for quick “Directions here”.</li>
          </ul>

          <h3 class="sub">Games &amp; saving</h3>
          <p class="muted">Everything autosaves on your device (☰ menu → history, rename, duplicate, export/import as JSON, or <strong>🖨 Print / save map (PDF)</strong>). Distance mode, units, colour theme, <strong>map style</strong> (Map / Satellite / Dark), and an optional per-question <strong>timer</strong> all live in Settings.</p>

          <div class="sheet-actions">
            <button id="hlp-close" class="btn btn-primary">Got it</button>
          </div>
        </div>`,
    });
    s.q("#hlp-close").onclick = () => s.close();
  }
}
