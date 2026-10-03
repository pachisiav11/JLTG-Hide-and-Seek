// The hider's side of a seekers' reference (question-ref.js): paste it, see it on the map, and
// measure your own position against it.
//
// Two ways in, both landing here:
//   - Questions ▸ 📥 Received question — one paste box for any question. The message names its
//     own question, so the hider cannot file it under the wrong one.
//   - Measuring / Matching / Tentacles ▸ pick the card ▸ 📥 Paste the seekers' version — for a
//     hider who goes to the question first. A reference for a DIFFERENT card is refused there,
//     rather than drawing, say, a body of water while the hider believes it is the coastline.
//
// What the hider gets is display and measurement only. A received reference never becomes a
// question on this phone (that was the players' call: "hider view only"), never eliminates
// anything, and never feeds `history`. The measure aid shows distances side by side with the
// seekers' own figure and stops there — see measure-aid.js for why that is a deliberate,
// bounded exception to the no-auto-answer rule.
import * as store from "./store.js";
import { parseQuestionRef, describeReference, describeSeekerSide, refMatchesCard } from "./question-ref.js";
import { measureAgainstRef } from "./measure-aid.js";
import { openSheet, toast, escapeHtml, formatDistance } from "./ui.js";
import { geoWatch } from "./geo-watch.js";

// Same identity colours the seeker's line pickers use, so a line reads the same on both phones.
const LINE_COLOURS = ["#f472b6", "#38bdf8", "#facc15", "#4ade80", "#c084fc", "#fb923c", "#22d3ee", "#f87171"];
const POI_LIST_LIMIT = 5; // the aid's nearest-places list; the full list is in the sheet above it

const uid = () => `rcv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const units = () => store.getCurrent()?.settings?.units || "metric";
const fmt = (m) => formatDistance(m, units());

// A stored entry is trusted only as far as it can be drawn. A record written by a future
// version, or hand-edited, must not take the map down with it.
function usable(entry) {
  const r = entry?.ref;
  return !!r && Array.isArray(r.pois) && Array.isArray(r.lines) && Array.isArray(r.polygons) && typeof r.title === "string";
}

export class Received {
  constructor(map, { layers = null } = {}) {
    this.map = map;
    this.layers = layers; // for pick(): "✋ Tap where I am"
    this.overlays = [];
  }

  init() {
    store.subscribe(() => this.render());
  }

  list() {
    return (store.getCurrent()?.received || []).filter(usable);
  }

  get(id) {
    return this.list().find((e) => e.id === id) || null;
  }

  // Store a parsed reference. A re-paste of the SAME message (same question, same send time)
  // replaces the earlier copy instead of stacking duplicates on the map.
  add(ref) {
    const entry = { id: uid(), receivedAt: Date.now(), shown: true, ref };
    store.update((g) => {
      const list = Array.isArray(g.received) ? g.received : [];
      const same = (e) => e?.ref?.title === ref.title && e?.ref?.sentAt && e.ref.sentAt === ref.sentAt;
      g.received = [...list.filter((e) => !same(e)), entry];
    });
    return entry;
  }

  remove(id) {
    store.update((g) => { g.received = (g.received || []).filter((e) => e.id !== id); });
  }

  setShown(id, shown) {
    store.update((g) => {
      const e = (g.received || []).find((x) => x.id === id);
      if (!e) return false;
      e.shown = !!shown;
    });
  }

  // ---- Map ----
  render() {
    this._clear();
    if (typeof google === "undefined" || !google.maps) return;
    for (const e of this.list()) {
      if (!e.shown) continue;
      try { this._draw(e.ref); }
      catch (err) { console.warn("received reference failed to draw", err); }
    }
  }

  _draw(ref) {
    ref.polygons.forEach((g) => {
      this.overlays.push(new google.maps.Polygon({
        paths: g.ring.map(([lat, lng]) => ({ lat, lng })),
        strokeColor: "#facc15", strokeOpacity: 0.95, strokeWeight: 3,
        fillColor: "#facc15", fillOpacity: g.role === "area" ? 0.18 : 0.06,
        clickable: false, zIndex: 6, map: this.map,
      }));
    });
    ref.lines.forEach((l, i) => {
      const colour = LINE_COLOURS[i % LINE_COLOURS.length];
      for (const path of l.paths) {
        this.overlays.push(new google.maps.Polyline({ path, strokeColor: colour, strokeOpacity: 0.95, strokeWeight: 4, clickable: false, zIndex: 7, map: this.map }));
      }
    });
    ref.pois.forEach((q) => {
      this.overlays.push(new google.maps.Marker({
        position: { lat: q.lat, lng: q.lng }, map: this.map, zIndex: 9, title: q.name,
        label: { text: String(q.n), color: "#04252a", fontWeight: "700" },
      }));
    });
    if (ref.center) {
      this.overlays.push(new google.maps.Marker({ position: ref.center, map: this.map, zIndex: 9, title: "Seekers' position", label: { text: "S", color: "#04252a", fontWeight: "700" } }));
      if (ref.radiusM) {
        this.overlays.push(new google.maps.Circle({ center: ref.center, radius: ref.radiusM, strokeColor: "#38bdf8", strokeOpacity: 0.9, strokeWeight: 2, fillColor: "#38bdf8", fillOpacity: 0.05, clickable: false, map: this.map }));
      }
    }
  }

  _clear() {
    this.overlays.forEach((o) => o.setMap(null));
    this.overlays = [];
  }

  fitTo(ref) {
    try {
      const b = new google.maps.LatLngBounds();
      ref.pois.forEach((q) => b.extend({ lat: q.lat, lng: q.lng }));
      ref.lines.forEach((l) => l.paths.forEach((p) => p.forEach((c) => b.extend(c))));
      ref.polygons.forEach((g) => g.ring.forEach(([lat, lng]) => b.extend({ lat, lng })));
      if (ref.center) b.extend(ref.center);
      if (!b.isEmpty()) this.map.fitBounds(b, 64);
    } catch (e) { console.warn("fit to received reference failed", e); }
  }

  // ---- Paste ----
  /**
   * The paste box. `expect` ({ tool, cardId, cardLabel }) is set when the hider came through a
   * specific question card, and a reference for any other card is refused with a reason.
   */
  openPasteSheet({ expect = null } = {}) {
    const title = escapeHtml(expect ? `Seekers' ${expect.cardLabel}` : "Received question");
    const s = openSheet({
      title,
      bodyHTML: `
        <p class="muted">${expect
          ? `Paste the message the seekers sent for <strong>${escapeHtml(expect.cardLabel)}</strong>. You'll see their exact ${expect.tool === "measuring" ? "reference" : "line or places"} on your map, so you answer against the same thing they are.`
          : `For the <strong>hider</strong>: paste the whole message the seekers sent with 📤 Copy for hider. You'll see their exact line or places on your map, so you answer against the same thing they are.`}</p>
        <textarea id="rq-text" class="field" rows="5" placeholder="JLTG question for the hider — …"></textarea>
        <div class="sheet-actions">
          <button id="rq-cancel" class="btn btn-ghost">Cancel</button>
          <button id="rq-clip" class="btn">📋 Paste</button>
          <button id="rq-go" class="btn btn-primary">Show it</button>
        </div>
        <p id="rq-status" class="muted"></p>`,
    });
    const status = (t) => { s.q("#rq-status").textContent = t; };
    s.q("#rq-cancel").onclick = () => s.close();
    s.q("#rq-clip").onclick = async () => {
      try { s.q("#rq-text").value = await navigator.clipboard.readText(); status(""); }
      catch { status("Couldn't read the clipboard — long-press the box and paste."); }
    };
    s.q("#rq-go").onclick = () => {
      let ref;
      try { ref = parseQuestionRef(s.q("#rq-text").value); }
      catch (e) { status(e.message); return; }
      if (expect && !refMatchesCard(ref, expect)) {
        status(`This is the seekers' ${ref.title} question, not ${expect.cardLabel}. Pick ${ref.label} instead, or paste it into Questions ▸ 📥 Received question.`);
        return;
      }
      const entry = this.add(ref);
      s.close();
      this.fitTo(ref);
      this.openView(entry.id);
    };
    return s;
  }

  // ---- View ----
  /**
   * One received question: what the seekers sent, their side of it, and the measure aid.
   * `aid` ({ point, source, accuracy }) re-opens the sheet with a measurement already taken —
   * the tap-to-measure path has to close the sheet to free the map, and comes back here.
   */
  openView(id, { aid = null } = {}) {
    const entry = this.get(id);
    if (!entry) { toast("That received question is gone."); return null; }
    const ref = entry.ref;
    const side = describeSeekerSide(ref, fmt);
    const when = new Date(entry.receivedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    // One span per row: `.list li` is a space-between flex row (name ⟷ actions), which would
    // otherwise scatter the number, the name and the note across the width.
    const mark = (yes) => (yes ? ` <span class="muted">— seekers' nearest</span>` : "");
    const items = [
      ...ref.pois.map((q) => `<li><span><strong>${q.n}.</strong> ${escapeHtml(q.name)}${mark(ref.seeker?.nearest === q.n)}</span></li>`),
      ...ref.lines.map((l, i) => `<li><span><span class="line-dot" style="background:${LINE_COLOURS[i % LINE_COLOURS.length]}"></span> ${escapeHtml(l.name)}${mark(ref.seeker?.nearestLine === l.id)}</span></li>`),
      ...ref.polygons.map((g) => `<li><span>▱ ${escapeHtml(g.name || (g.role === "area" ? "Area" : "Region"))}</span></li>`),
    ].join("");
    const s = openSheet({
      title: escapeHtml(ref.title),
      mapInteractive: true,
      bodyHTML: `
        <p class="muted">From the seekers · received ${escapeHtml(when)} · ${escapeHtml(describeReference(ref))} — drawn on your map.</p>
        ${side ? `<p class="share-ref-summary"><strong>${escapeHtml(side)}</strong></p>` : ""}
        <ul class="list received-items">${items}</ul>
        <h3 class="sub">Measure yourself against it</h3>
        <div class="row">
          <button id="rv-gps" class="btn btn-primary">📍 From my location</button>
          <button id="rv-tap" class="btn">✋ Tap where I am</button>
        </div>
        <div id="rv-aid" class="share-ref-body" ${aid ? "" : "hidden"}></div>
        <p class="muted">The app measures; it doesn't answer for you. Compare, then tell the seekers your answer.</p>
        <div class="sheet-actions">
          <button id="rv-remove" class="btn btn-ghost">🗑 Remove</button>
          <button id="rv-toggle" class="btn">${entry.shown ? "🙈 Hide from map" : "👁 Show on map"}</button>
          <button id="rv-done" class="btn btn-primary">Done</button>
        </div>`,
    });
    const showAid = (point, source, accuracy = null) => {
      const box = s.q("#rv-aid");
      try {
        box.innerHTML = aidHTML(ref, measureAgainstRef(ref, point), { source, accuracy });
      } catch (e) {
        console.warn("measure aid failed", e);
        box.textContent = "Couldn't measure against this reference.";
      }
      box.hidden = false;
    };
    s.q("#rv-gps").onclick = async () => {
      const box = s.q("#rv-aid");
      box.hidden = false;
      box.textContent = "Getting your location…";
      const fix = await currentFix();
      if (!fix) { box.textContent = "No GPS fix — try again outdoors, or use ✋ Tap where I am."; return; }
      showAid(fix, "gps", fix.accuracy);
    };
    s.q("#rv-tap").onclick = async () => {
      if (!this.layers?.pick) { toast("Tapping the map isn't available here."); return; }
      const pts = await this.layers.pick(1, "Tap where you are.");
      this.openView(id, pts ? { aid: { point: pts[0], source: "tap" } } : {});
    };
    s.q("#rv-toggle").onclick = () => { this.setShown(id, !entry.shown); s.close(); this.openView(id); };
    s.q("#rv-remove").onclick = () => { this.remove(id); s.close(); toast("Removed."); };
    s.q("#rv-done").onclick = () => s.close();
    if (aid) showAid(aid.point, aid.source, aid.accuracy);
    return s;
  }

  // Rows for the Questions panel. Built here so the panel does not need to know the shape.
  panelRowsHTML() {
    const list = this.list();
    if (!list.length) return "";
    return `<h3 class="sub">Received from seekers</h3>
      <ul class="list">${list.map((e) => `
        <li>
          <span class="li-name ${e.shown ? "" : "off"}">📥 ${escapeHtml(e.ref.title)}</span>
          <span class="li-actions">
            <button class="btn btn-ghost btn-sm" data-rcv-view="${e.id}">View</button>
            <button class="btn btn-ghost btn-sm" data-rcv-del="${e.id}">🗑</button>
          </span>
        </li>`).join("")}</ul>`;
  }

  wirePanelRows(sheet, { reopen } = {}) {
    sheet.qa("[data-rcv-view]").forEach((b) => (b.onclick = () => {
      const e = this.get(b.dataset.rcvView);
      if (e) { this.fitTo(e.ref); this.openView(e.id); }
    }));
    sheet.qa("[data-rcv-del]").forEach((b) => (b.onclick = () => { this.remove(b.dataset.rcvDel); sheet.close(); reopen?.(); }));
  }
}

// One GPS fix from the shared watch, or null after a timeout. The same singleton the blue dot
// rides, so this is usually instant.
function currentFix(timeoutMs = 10000) {
  if (geoWatch.lastFix) return Promise.resolve({ ...geoWatch.lastFix });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; unsub(); resolve(v); };
    const unsub = geoWatch.subscribe((fix) => finish({ ...fix }), () => finish(null));
    setTimeout(() => finish(null), timeoutMs);
  });
}

// The measure aid, in words. Every line is a measurement with the seekers' figure beside it
// where they sent one; no line says what the answer is.
export function aidHTML(ref, m, { source = "gps", accuracy = null } = {}) {
  const out = [];
  const from = source === "tap" ? "From the point you tapped" : `From your GPS${Number.isFinite(accuracy) ? ` (±${fmt(accuracy)})` : ""}`;
  out.push(`<p class="muted">${escapeHtml(from)}:</p>`);
  const seekersD = ref.seeker?.distanceM;

  if (m.polygons.length) {
    for (const g of m.polygons) {
      const what = g.role === "area" ? `the ${escapeHtml(ref.label.toLowerCase())}` : "the outlined region";
      out.push(`<p>You are <strong>${g.inside ? "inside" : "outside"}</strong> ${what} · edge ${escapeHtml(fmt(g.edgeDistanceM))} away.</p>`);
    }
    if (ref.tool === "measuring" && ref.variant === "area") {
      const yours = m.polygons.every((g) => !g.inside) ? Math.min(...m.polygons.map((g) => g.edgeDistanceM)) : 0;
      out.push(`<p>Your distance: <strong>${escapeHtml(fmt(yours))}</strong>${Number.isFinite(seekersD) ? ` · seekers': <strong>${escapeHtml(fmt(seekersD))}</strong>` : ""}</p>`);
    }
  }
  if (m.lines.length) {
    if (ref.tool === "measuring") {
      out.push(`<p>Your distance to their ${escapeHtml(ref.label.toLowerCase())}: <strong>${escapeHtml(fmt(m.lines[0].distanceM))}</strong>${Number.isFinite(seekersD) ? ` · seekers': <strong>${escapeHtml(fmt(seekersD))}</strong>` : ""}</p>`);
    } else {
      out.push(`<p>Your distance to each of their lines:</p><ul class="list">${m.lines.map((l) => `<li>${escapeHtml(l.name)} — ${escapeHtml(fmt(l.distanceM))}</li>`).join("")}</ul>`);
    }
  }
  if (m.pois.length) {
    if (ref.tool === "measuring") {
      out.push(`<p>Your distance to the nearest of their ${escapeHtml(ref.label.toLowerCase())} places: <strong>${escapeHtml(fmt(m.pois[0].distanceM))}</strong> (#${m.pois[0].n} ${escapeHtml(m.pois[0].name)})${Number.isFinite(seekersD) ? ` · seekers': <strong>${escapeHtml(fmt(seekersD))}</strong>` : ""}</p>`);
    } else {
      const shown = m.pois.slice(0, POI_LIST_LIMIT);
      out.push(`<p>Their places, nearest to you first:</p><ul class="list">${shown.map((q) => `<li>#${q.n} ${escapeHtml(q.name)} — ${escapeHtml(fmt(q.distanceM))}</li>`).join("")}</ul>${m.pois.length > shown.length ? `<p class="muted">+${m.pois.length - shown.length} farther.</p>` : ""}`);
    }
  }
  if (m.center) {
    out.push(`<p>You are <strong>${escapeHtml(fmt(m.center.distanceM))}</strong> from the seekers' position${m.center.radiusM ? `; their reach is ${escapeHtml(fmt(m.center.radiusM))}` : ""}.</p>`);
  }
  return out.join("");
}
