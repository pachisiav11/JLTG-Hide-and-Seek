// Game history browser, settings, and import/export (guide §6.3, §7 screens 5–6).
import * as store from "./store.js";
import { DEFAULT_SETTINGS } from "./model.js";
import { openSheet, toast, loadingToast, escapeHtml, promptText } from "./ui.js";
import { getPaletteName, setPalette } from "./palette.js";
import { makeManualStation } from "./stations.js";
import { formatLocationForClipboard } from "./ingest.js";
import { LiveShare, generateSessionCode, parseApproachKm } from "./live-share.js";
import { guideBodyHTML } from "./guide.js";
import { formatBuildStamp } from "./build-info.js";
import { isNativeCapacitor } from "./bg-spike.js";
import { queryGrants, wizardHTML, openSettingsFor, alertsReachCopy, mountReadinessNote } from "./native-permissions.js";

export class Games {
  constructor(zones, { boundaries = null, features = null, library = null, liveShare = null, layers = null } = {}) {
    this.zones = zones; // used to fit the map after opening a game
    this.boundaries = boundaries; // reference-boundary overlays (cleared on wipe)
    this.features = features; // transient map features (route/measure/transit)
    this.library = library; // reusable custom categories + pins (Phase 9)
    this.liveShare = liveShare; // §C5 live seeker↔hider location channel
    this.layers = layers; // map-tap point picking — "Add stations (tap map)"
    // `map` and `lines` used to be held here for board-wide Places station sourcing and for
    // eliminate-by-line. Both features are gone, and nothing else in this class touched them.
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
          <button id="mn-copyloc" class="btn">📋 Copy MY location</button>
          <button id="mn-liveshare" class="btn">📡 Live location share (session)</button>
          <button id="mn-rename" class="btn">✏️ Rename current</button>
          <button id="mn-dup" class="btn">⧉ Duplicate current</button>
          <button id="mn-export" class="btn">⬇️ Export current (JSON)</button>
          <button id="mn-import" class="btn">⬆️ Import game</button>
          <button id="mn-print" class="btn">🖨 Print / save map (PDF)</button>
          <button id="mn-share" class="btn">🔗 Share link</button>
          <button id="mn-settings" class="btn">⚙️ Settings</button>
        </div>`,
    });
    s.q("#mn-new").onclick = async () => { s.close(); await this.newGame(); };
    s.q("#mn-clear").onclick = () => { s.close(); this.clearBoard(); };
    s.q("#mn-history").onclick = () => { s.close(); this.openHistory(); };
    s.q("#mn-library").onclick = () => { s.close(); this.library ? this.library.openManager() : toast("Library unavailable."); };
    s.q("#mn-stations").onclick = () => { s.close(); this.openStations(); };
    s.q("#mn-copyloc").onclick = () => { s.close(); this.copyMyLocation(); };
    s.q("#mn-liveshare").onclick = () => { s.close(); this.openLiveShare(); };
    s.q("#mn-rename").onclick = () => { s.close(); this.rename(); };
    s.q("#mn-dup").onclick = async () => { s.close(); await this.duplicate(); };
    s.q("#mn-export").onclick = async () => { await this.exportCurrent(); };
    s.q("#mn-import").onclick = () => { s.close(); this.openImport(); };
    s.q("#mn-print").onclick = () => { s.close(); this.printMap(); };
    s.q("#mn-share").onclick = () => { s.close(); this.shareCurrent(); };
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

  // v2 Phase 6, item U — put the whole game in a link.
  //
  // For a game where players hand a phone around or coordinate over chat, this is the
  // highest value-per-line feature borrowed from the reference mapper: no accounts, no
  // backend, no upload.
  //
  // NOT copied: the reference's overflow path, which POSTs an oversized game to Pastebin
  // through `cors-anywhere.com` — the user's API key and their whole board through a
  // third-party CORS proxy of unclear provenance. An oversized board is told to use the JSON
  // export it already has. A share button must never be the reason data leaves the device by
  // a route the player did not choose.
  async shareCurrent() {
    const cur = store.getCurrent();
    if (!cur) return toast("Open a game first.");
    let built;
    try {
      const { buildShareUrl } = await import("./share-link.js");
      built = await buildShareUrl(cur, window.location.href);
    } catch (e) {
      return toast(e.message || "Couldn't build a share link.");
    }

    if (built.tooLong) {
      return toast(`This board is too big for a link (${built.length} characters). Use Export JSON and send the file instead.`);
    }

    const s = openSheet({
      title: "Share this game",
      bodyHTML: `
        <p class="muted">The whole board — zones, questions and answers — travels in this link. Nothing is uploaded anywhere.</p>
        <p class="muted">Your <strong>notes are not included</strong>, and neither is the station list (it is re-sourced from the board on the other device; your station eliminations do travel).</p>
        <textarea id="sh-url" class="field" rows="4" readonly>${escapeHtml(built.url)}</textarea>
        <div class="sheet-actions">
          <button id="sh-close" class="btn btn-ghost">Close</button>
          <button id="sh-copy" class="btn btn-primary">Copy link</button>
        </div>
        <p id="sh-status" class="muted"></p>`,
    });
    s.q("#sh-close").onclick = () => s.close();
    s.q("#sh-copy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(built.url);
        s.q("#sh-status").textContent = "Copied.";
      } catch {
        // Clipboard is permission-gated and blocked outright in some in-app browsers.
        // Selecting the text is the fallback that always works.
        s.q("#sh-url").select();
        s.q("#sh-status").textContent = "Couldn't copy automatically — the link is selected, copy it manually.";
      }
    };
  }

  // Load a game handed over in a URL. Called once at startup; a no-op without the parameter.
  //
  // The link is UNTRUSTED INPUT — it came from another device through a chat app that may
  // have truncated it. `parseShareToken` validates rather than trusts, and anything malformed
  // refuses with a reason instead of half-loading a board, because a board that loads with
  // some questions silently missing is worse than one that refuses: the seeker cannot see
  // what is absent.
  async loadFromShareLink() {
    let token;
    try {
      const { tokenFromUrl } = await import("./share-link.js");
      token = tokenFromUrl(window.location.href);
    } catch { return false; }
    if (!token) return false;

    try {
      const { parseShareToken } = await import("./share-link.js");
      const payload = await parseShareToken(token);
      const g = await store.newGame({
        name: payload.name ? `${payload.name} (shared)` : "Shared game",
        zones: payload.zones || [],
        focusZone: payload.focusZone || undefined,
        history: payload.history || [],
        railFilter: payload.railFilter || undefined,
        settings: payload.settings || undefined,
        // A hand-tapped shortlist cannot be re-sourced on the receiving device, so the link
        // carries it outright. Older links (pre-shortlist) have no `stations` and are left
        // with an empty one rather than a half-restored set.
        stations: { list: Array.isArray(payload.stations) ? payload.stations : [] },
      });
      await store.openGame(g.id);
      this.zones?.fitToArea();
      toast("Shared game loaded.");
    } catch (e) {
      toast(e.message || "That share link could not be read.");
    } finally {
      // Clear the parameter either way, so a refresh does not re-import the same board and
      // leave the player with a pile of duplicates.
      try { window.history.replaceState({}, "", window.location.pathname); } catch { /* non-browser */ }
    }
    return true;
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

  // ---- Stations (a late-game shortlist) ----
  //
  // Deliberately small. This was a LOCKED SET: sourced board-wide from OSM or Google Places
  // before play, confirmed once, and treated as the authoritative station domain for the rest
  // of the game — which meant a Mumbai or Tokyo board asked the seeker to materialise several
  // hundred stations on turn one before anything referred to them.
  //
  // That is backwards. The list is useful at the END of a game: six candidates left, work
  // through them one at a time, strike off the ones a photo or an ambient clue rules out. So
  // the only way to build it is now tapping the map, and there is nothing to lock in.
  //
  // Removed with the sourcing: bulk eliminate-by-line, range-along-line ("not past Dahisar"),
  // the OSM/Places pickers and the confirmation gate. Station's Line no longer reads this list
  // at all — it sources and confirms its own stations per question (see layers.js).
  async openStations() {
    const g = store.getCurrent();
    if (!g) return;
    this._stationsSheet(g, g.gameArea ? {} : {
      info: "Draw a play area first — stations are placed inside it.",
      actions: false,
    });
  }

  _stationsSheet(g, { info = null, actions = true } = {}) {
    const st = g.stations || { list: [] };
    const rows = st.list.length
      ? st.list.map((s) => `
          <li class="station-row" data-id="${escapeHtml(s.id)}">
            <label class="station-keep">
              <input type="checkbox" class="st-elim" data-id="${escapeHtml(s.id)}" ${s.eliminated ? "checked" : ""}/>
              <span class="${s.eliminated ? "station-out" : ""}">${escapeHtml(s.name)}</span>
            </label>
            <span class="muted">${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}</span>
            <button class="btn btn-ghost btn-sm st-drop" data-id="${escapeHtml(s.id)}" title="Remove from list">🗑</button>
          </li>`).join("")
      : `<li class="muted">No stations yet — tap the map to add the ones still in play.</li>`;
    const live = st.list.filter((x) => !x.eliminated).length;
    const meta = st.list.length
      ? `<p class="muted"><strong>${live}</strong> still in play of ${st.list.length} added.</p>`
      : "";

    const s = openSheet({
      title: "Stations",
      bodyHTML: `
        <p class="muted">A shortlist of the stations you are still considering. Add them when a game has narrowed down, then tick one off as you rule it out — here, or by long-pressing its marker on the map.</p>
        ${info ? `<p class="warn-note">${escapeHtml(info)}</p>` : ""}
        ${meta}
        ${actions ? `
        <div class="row"><button id="st-pick" class="btn">📍 Add stations (tap map)</button></div>
        <ul class="list station-list">${rows}</ul>
        <div class="sheet-actions">
          <button id="st-clear" class="btn btn-ghost" ${st.list.length ? "" : "disabled"}>Clear list</button>
        </div>` : ""}
      `,
    });
    if (!actions) return s;

    const refresh = () => { s.close(); this._stationsSheet(store.getCurrent()); };

    // Keep tapping to drop as many station pins as needed, each added directly at the tapped
    // point — no snapping to an existing station and no name prompt (see makeManualStation).
    const pickBtn = s.q("#st-pick");
    if (pickBtn) pickBtn.onclick = async () => {
      if (!this.layers?.pickMulti) return toast("Map isn’t ready.");
      s.close(); // pickMulti() closes any sheet anyway; do it explicitly so the map is clear
      const pts = await this.layers.pickMulti("Tap the map to drop a station. Tap Done when finished.", { constrainToArea: true });
      if (!pts || !pts.length) return; // cancelled, or Done with nothing added
      store.update((gg) => {
        if (!gg.stations) gg.stations = { list: [] };
        if (!Array.isArray(gg.stations.list)) gg.stations.list = [];
        let seq = gg.stations.list.length;
        for (const p of pts) {
          seq += 1;
          const manual = makeManualStation(p, seq);
          if (manual) gg.stations.list.push(manual);
        }
      });
      store.saveNow();
      toast(`${pts.length} station${pts.length === 1 ? "" : "s"} added.`);
      refresh();
    };
    s.q("#st-clear").onclick = () => {
      store.update((gg) => { gg.stations = { list: [] }; });
      store.saveNow();
      toast("Station list cleared.");
      refresh();
    };
    for (const el of s.qa(".st-drop")) {
      el.onclick = () => {
        const id = el.dataset.id;
        store.update((gg) => {
          if (!gg.stations?.list) return false;
          gg.stations.list = gg.stations.list.filter((s) => s.id !== id);
        });
        store.saveNow();
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
          entry.eliminatedBy = el.checked ? "manual" : null;
        });
        store.saveNow();
        refresh();
      };
    }
    return s;
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
    // Phase 28 (req #4): decide which threshold control reflects the stored
    // value. The four presets + "Off" are exact metre matches; anything else
    // positive is a Custom km value the hider typed, so pre-select Custom and
    // seed the km input from it. Exactly one control is checked (the old
    // `!approachThresholdM` fallback double-checked both Off and 2 km at 0).
    const thm = Number(st.approachThresholdM);
    const PRESETS = [0, 500, 1000, 2000, 5000];
    const isCustom = Number.isFinite(thm) && thm > 0 && !PRESETS.includes(thm);
    const isPreset = (v) => Number.isFinite(thm) && !isCustom && thm === v;
    const customKm = isCustom ? String(parseFloat((thm / 1000).toFixed(3))) : "";
    const proxy = window.JLTG_CONFIG?.MULTIPLAYER_URL || window.JLTG_CONFIG?.OVERPASS_PROXY_URL || "";
    const shareState = this.liveShare;
    const s = openSheet({
      title: "Live location share",
      bodyHTML: `
        <p class="muted">A narrow one-way channel: the SEEKER's device streams its GPS to the HIDER's device (no game state). The <strong>HIDER</strong> generates a 4-digit code and reads it out to the <strong>SEEKER</strong>, who types it in.</p>
        ${!proxy ? `<p class="warn-note">No relay URL is configured (OVERPASS_PROXY_URL / MULTIPLAYER_URL). The share won't reach the other device — set it in config.js or in the deployment env vars.</p>` : ""}
        <label class="fieldlbl">Session code</label>
        <div class="row">
          <input id="ls-code" class="field" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" spellcheck="false" autocomplete="off" value="${escapeHtml(shareState?.code || localStorage.getItem("jltg.liveShareCode") || "")}" placeholder="4-digit code"/>
          <button id="ls-gen" class="btn">🎲 Generate (as HIDER)</button>
        </div>
        <label class="fieldlbl">Approach threshold (hider only) — alert when seeker is within this distance of your zone centre</label>
        <div class="seg">
          <label><input type="radio" name="ls-th" value="0" ${isPreset(0) ? "checked" : ""}/> Off (pin only)</label>
          <label><input type="radio" name="ls-th" value="500" ${isPreset(500) ? "checked" : ""}/> 500 m</label>
          <label><input type="radio" name="ls-th" value="1000" ${isPreset(1000) ? "checked" : ""}/> 1 km</label>
          <label><input type="radio" name="ls-th" value="2000" ${isPreset(2000) ? "checked" : ""}/> 2 km</label>
          <label><input type="radio" name="ls-th" value="5000" ${isPreset(5000) ? "checked" : ""}/> 5 km</label>
          <label><input type="radio" name="ls-th" value="custom" ${isCustom ? "checked" : ""}/> Custom
            <input id="ls-th-km" class="field field-inline" type="number" step="any" min="0" value="${escapeHtml(customKm)}" placeholder="km"/> km</label>
        </div>
        <p class="muted">Status: <strong>${shareState?.role ? `${shareState.role} in "${escapeHtml(shareState.code || "")}"` : "not connected"}</strong></p>
        <div class="row">
          <button id="ls-seeker" class="btn">📡 Share as SEEKER</button>
          <button id="ls-hider" class="btn">🎯 Receive as HIDER</button>
        </div>
        <div class="sheet-actions">
          <button id="ls-stop" class="btn btn-ghost">Stop / disconnect</button>
          <button id="ls-save" class="btn btn-primary">💾 Save</button>
          <button id="ls-close" class="btn">Close</button>
        </div>`,
      // Phase 49 (req #5): previously ONLY the Close button (and connecting)
      // persisted a changed threshold — tapping the ✕ or the backdrop, the way
      // every other sheet in the app is dismissed, silently discarded it. The
      // hider had no way to tell a change "took" short of re-opening the sheet
      // and checking, which read as "you have to leave and re-enter the game to
      // save". Saving on EVERY dismissal path (plus the explicit Save button
      // below, for a player who wants to confirm without closing) closes that
      // gap without changing what gets saved.
      onClose: () => { if (saveThreshold()) store.saveNow(); },
    });
    s.q("#ls-gen").onclick = () => { s.q("#ls-code").value = generateSessionCode(); };
    // Typing in the km box implies the Custom option — auto-select its radio so
    // the value can't be silently ignored because a preset was still checked.
    const kmInput = s.q("#ls-th-km");
    if (kmInput) kmInput.oninput = () => {
      const custom = s.qa('input[name="ls-th"]').find((r) => r.value === "custom");
      if (custom) custom.checked = true;
    };
    const saveThreshold = () => {
      const raw = s.qa('input[name="ls-th"]').find((r) => r.checked)?.value || "2000";
      let v;
      if (raw === "custom") {
        // Reject junk/≤0; fall back to the current stored value rather than a
        // bogus threshold so a mistyped Custom doesn't disarm the alert. There
        // is no upper bound — see parseApproachKm — so the toast names the one
        // rule that is left rather than a range.
        v = parseApproachKm(kmInput?.value);
        if (v == null) { toast("Enter a custom distance in km, greater than zero."); return false; }
      } else {
        v = parseInt(raw, 10);
      }
      store.update((gg) => (gg.settings = { ...gg.settings, approachThresholdM: v }));
      return true;
    };
    const connect = async (role) => {
      const code = s.q("#ls-code").value.trim();
      if (!/^[0-9]{4}$/.test(code)) return toast("Enter the 4-digit code (the HIDER generates it, the SEEKER types it in).");
      localStorage.setItem("jltg.liveShareCode", code);
      if (!saveThreshold()) return;
      if (!proxy) return toast("No relay URL configured — cannot connect.");
      if (!shareState) return toast("Live-share isn't initialised in this session.");
      // Lazy-load the transport now, once per app session. Reuses the pattern
      // Phase 13 documented in MULTIPLAYER_DESIGN.md: load the client shim
      // from the backend so we don't ship a socket.io-client dep in the SW.
      if (!shareState.transport) {
        const hideLoading = loadingToast("Connecting…");
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
          shareState.setTransport(sock); // Socket.IO client IS the EventEmitter API LiveShare expects; also arms connect/disconnect pill updates
        } catch (e) {
          console.warn("live-share transport init failed", e);
          hideLoading();
          return toast(`Couldn't connect to relay — ${e.message}`);
        }
        hideLoading();
      }
      if (role === "seeker") shareState.startAsSeeker(code); else shareState.startAsHider(code);
      toast(`Live share: ${role} in "${code}"`);
      s.close();
    };
    s.q("#ls-seeker").onclick = () => connect("seeker");
    s.q("#ls-hider").onclick = () => connect("hider");
    s.q("#ls-stop").onclick = () => { shareState?.stop?.(); toast("Live share stopped."); s.close(); };
    // Explicit Save: persists immediately and stays open, so a hider mid-game who
    // just wants to bump the threshold gets a direct confirmation without having
    // to disconnect/reconnect or close the sheet to trust that it worked. Reads
    // back from the store, since _onSeekerPing already re-reads settings on every
    // ping — no reconnect needed for a saved threshold to take effect.
    s.q("#ls-save").onclick = () => {
      if (!saveThreshold()) return;
      store.saveNow();
      toast("Live-share settings saved.");
    };
    s.q("#ls-close").onclick = () => s.close(); // onClose (above) saves before the sheet actually closes
  }

  // ---- Copy MY location (§C2) ----
  //
  // The seeker has to type or paste their own coordinates into whatever chat
  // the group uses. One tap on this button reads the seeker's GPS, formats it
  // as a plain "lat, lng" string (§ src/ingest.js), and puts it on the clipboard.
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
        <p class="muted">While hiding, warn me when I'm this close to the edge of the Hider zone (or if I cross it). Also settable right in the 🎯 Hider-zone panel. Requires notification permission. Set to Off to disable.</p>
        <p class="muted">Only fires when your role is set to <strong>Hider</strong> in the 🎯 Hider-zone panel (defaults to Seeker).</p>
        <p class="muted">${alertsReachCopy(isNativeCapacitor())}</p>
        <div id="st-perm-note"></div>
        <div class="seg">
          ${radio("geofenceMetres", "0", String(st.geofenceMetres || 0), "Off")}
          ${radio("geofenceMetres", "50", String(st.geofenceMetres || 0), "50 m")}
          ${radio("geofenceMetres", "100", String(st.geofenceMetres || 0), "100 m")}
          ${radio("geofenceMetres", "200", String(st.geofenceMetres || 0), "200 m")}
        </div>
        <p class="muted">Alert style (§C3) — applies to both the geofence-edge and the live-share seeker-close alerts. Vibrate + tone reaches a phone in a pocket; <strong>Off</strong> shows no notification and no buzz/tone (the on-screen pill still updates).</p>
        <div class="seg">
          ${radio("geofenceAlertStyle", "off", st.geofenceAlertStyle || "vibrate-tone", "Off (no notification)")}
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
          <button id="st-guide" class="btn">📘 Guide</button>
        </div>
        <div class="sheet-actions">
          <button id="st-cancel" class="btn btn-ghost">Cancel</button>
          <button id="st-save" class="btn btn-primary">Save</button>
        </div>`,
    });
    s.q("#st-help").onclick = () => { s.close(); this.openInstructions(); };
    s.q("#st-guide").onclick = () => { s.close(); this.openGuide(); };
    // Same compact readiness note as the Hider-zone panel — see native-permissions.js
    // mountReadinessNote for why this lives in one shared place, not duplicated here.
    mountReadinessNote(s.q("#st-perm-note"), { onOpenGuide: () => { s.close(); this.openGuide(); } });
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
      // hidingRadiusM is deliberately absent: it is no longer a Settings control. It is typed on
      // the Station's Line answer sheet — its one consumer — and `...gg.settings` carries the
      // remembered value through untouched.
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

  // ---- Guide (Phase 38): feature reference for stations, live-share, alerts,
  // and the Android background track. Content lives in src/guide.js. ----
  openGuide() {
    const s = openSheet({ title: "Guide", bodyHTML: guideBodyHTML() });
    s.q("#guide-close").onclick = () => s.close();
    // Phase 45: on the Android shell, replace the Android section's static "here's
    // what it'll need" copy with a LIVE permissions wizard — detect each grant,
    // explain it, and deep-link to the exact settings screen. Off-device the
    // honest static caveat stays. Async (grants come from plugins), so the sheet
    // opens immediately and the wizard fills in.
    this._mountPermissionsWizard(s);
  }

  async _mountPermissionsWizard(sheet) {
    if (!isNativeCapacitor()) return;
    const section = sheet.q?.("#guide-android");
    if (!section) return;
    const render = async () => {
      let grant;
      try { grant = await queryGrants(); }
      catch (e) { console.warn("guide: permission query failed", e); return; }
      // Keep the section heading; swap the body for the wizard.
      const heading = section.querySelector("h3");
      section.innerHTML = (heading ? heading.outerHTML : "") + wizardHTML(grant);
      section.querySelectorAll("button[data-perm]").forEach((btn) => {
        btn.onclick = async () => {
          await openSettingsFor(btn.dataset.perm);
          // The user returns from Settings having (maybe) changed a grant; a
          // one-shot re-render on next open is enough, but re-check now too so the
          // badges refresh without reopening if the OS returns focus quickly.
          setTimeout(render, 400);
        };
      });
    };
    render();
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

          <p class="muted build-stamp">${escapeHtml(formatBuildStamp(window.JLTG_CONFIG || {}))}
            &middot; <a href="version.html">check for updates</a></p>

          <div class="sheet-actions">
            <button id="hlp-close" class="btn btn-primary">Got it</button>
          </div>
        </div>`,
    });
    s.q("#hlp-close").onclick = () => s.close();
  }
}
