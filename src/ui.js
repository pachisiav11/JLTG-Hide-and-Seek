// Lightweight UI primitives shared across the app: toasts and bottom sheets.

let activeSheet = null;

// Bumped on every toast()/loadingToast() call so a stale loadingToast's dismiss fn
// (returned before some NEWER toast took over the shared element) knows not to hide
// content it no longer owns.
let toastToken = 0;

function toastEl() {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  return t;
}

export function toast(msg, ms = 2400) {
  const t = toastEl();
  const myToken = ++toastToken;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { if (toastToken === myToken) t.classList.remove("show"); }, ms);
}

// For a load of unknown duration (a fetch, geocode, reverse-geocode, GPS fix, …):
// show `msg` and keep it up — no auto-hide timer — until the caller invokes the
// returned function. Use this instead of toast() for "X is loading…" messages so the
// toast disappearing is tied to the load actually finishing, not a guessed duration.
export function loadingToast(msg) {
  const t = toastEl();
  const myToken = ++toastToken;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = null;
  return () => { if (toastToken === myToken) t.classList.remove("show"); };
}

// Open a bottom sheet. `bodyHTML` is inserted into the content area; the returned
// object exposes the root element, a query helper, and a close() fn.
// `mapInteractive: true` makes the backdrop non-blocking (transparent + no pointer
// capture) so the user can still pan/zoom the Google map behind the sheet — used by
// the POI candidate / search flows where seeing and moving the map matters. It also
// drops backdrop-click-to-close (there is nothing to click through to close).
export function openSheet({ title, bodyHTML = "", onClose, mapInteractive = false } = {}) {
  closeSheet();
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop" + (mapInteractive ? " ghost" : "");

  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.innerHTML = `
    <div class="sheet-grip" aria-hidden="true"></div>
    <div class="sheet-head">
      <h2 class="sheet-title">${title || ""}</h2>
      <button class="sheet-close" aria-label="Close">✕</button>
    </div>
    <div class="sheet-body"></div>
  `;
  sheet.querySelector(".sheet-body").innerHTML = bodyHTML;

  const close = () => {
    if (activeSheet !== api) return;
    sheet.classList.remove("open");
    backdrop.classList.remove("open");
    setTimeout(() => {
      backdrop.remove();
      sheet.remove();
    }, 250);
    activeSheet = null;
    onClose?.();
  };

  if (!mapInteractive) backdrop.addEventListener("click", close);
  sheet.querySelector(".sheet-close").addEventListener("click", close);

  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  requestAnimationFrame(() => {
    backdrop.classList.add("open");
    sheet.classList.add("open");
  });

  const api = {
    el: sheet,
    body: sheet.querySelector(".sheet-body"),
    q: (sel) => sheet.querySelector(sel),
    qa: (sel) => Array.from(sheet.querySelectorAll(sel)),
    setTitle: (t) => (sheet.querySelector(".sheet-title").textContent = t),
    close,
  };
  activeSheet = api;
  return api;
}

export function closeSheet() {
  activeSheet?.close();
}

// A tiny popup menu anchored at screen coordinates (used for long-press actions).
export function contextMenu(x, y, items) {
  const existing = document.getElementById("ctx-menu");
  existing?.remove();
  const menu = document.createElement("div");
  menu.id = "ctx-menu";
  menu.className = "ctx-menu";
  for (const item of items) {
    const b = document.createElement("button");
    b.textContent = item.label;
    b.addEventListener("click", () => {
      menu.remove();
      item.onClick?.();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  // Keep on screen.
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 8);
  const py = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, px)}px`;
  menu.style.top = `${Math.max(8, py)}px`;
  const dismiss = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("pointerdown", dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", dismiss, true), 0);
  return menu;
}

// Format a distance for display honouring the units setting.
export function formatDistance(meters, units = "metric") {
  if (units === "imperial") {
    const ft = meters * 3.28084;
    return ft >= 5280 ? `${(ft / 5280).toFixed(2)} mi` : `${Math.round(ft)} ft`;
  }
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

// ---- Distance INPUT ------------------------------------------------------------------
// Distance fields used to be hard-coded to "metres" while the rest of the app honoured
// settings.units. An imperial player saw ft/mi everywhere else, typed the mile figure the
// hider gave them into a field labelled "metres", and the buffer came out ~1609x wrong.
//
// A single unit per system isn't enough — players say both "500 feet" and "a quarter
// mile" — so the field carries a unit picker. Storage stays metric everywhere: these
// helpers convert at the UI boundary only.
const DISTANCE_UNITS = {
  metric: [{ id: "m", label: "m", per: 1 }, { id: "km", label: "km", per: 1000 }],
  imperial: [{ id: "ft", label: "ft", per: 0.3048 }, { id: "mi", label: "mi", per: 1609.344 }],
};

const unitsFor = (units) => DISTANCE_UNITS[units] || DISTANCE_UNITS.metric;

// Pick the display unit + value for a metre amount, switching at the same points as
// formatDistance (ft below a mile, m below a km).
export function splitDistance(meters, units = "metric") {
  const [small, big] = unitsFor(units);
  const useBig = Number.isFinite(meters) && meters >= big.per;
  const u = useBig ? big : small;
  const value = Number.isFinite(meters) ? +(meters / u.per).toFixed(useBig ? 2 : 0) : "";
  return { unit: u.id, value };
}

// A number field + unit select. The select's id is `${id}-unit`.
export function distanceFieldHTML(id, meters, units = "metric", { placeholder = "" } = {}) {
  const opts = unitsFor(units);
  const { unit, value } = splitDistance(meters, units);
  const options = opts
    .map((o) => `<option value="${o.id}"${o.id === unit ? " selected" : ""}>${o.label}</option>`)
    .join("");
  return `<div class="row">
      <input id="${id}" class="field" type="number" inputmode="decimal" value="${value}"
             placeholder="${escapeHtml(placeholder)}" min="0" step="any" />
      <select id="${id}-unit" class="field" aria-label="Units">${options}</select>
    </div>`;
}

// Read a distance field back as METRES. Returns NaN when the input isn't a number, so
// callers can reject bad input rather than silently substituting a default.
export function readDistanceMeters(sheet, id, units = "metric") {
  const opts = unitsFor(units);
  const raw = parseFloat(sheet.q(`#${id}`)?.value);
  if (!Number.isFinite(raw)) return NaN;
  const picked = sheet.q(`#${id}-unit`)?.value;
  const u = opts.find((o) => o.id === picked) || opts[0];
  return raw * u.per;
}

// The unit word for prose labels ("Radius" / "Your distance").
export function distanceUnitWord(units = "metric") {
  return units === "imperial" ? "feet or miles" : "metres or km";
}

// ---- Filtered radio-list selection ---------------------------------------------------
// Decide what should be checked after a name filter is applied to a pick-exactly-one list.
//
// Filtering used to set `display` only and never touch `checked`, so typing "Waterloo",
// seeing only Waterloo and pressing Add recorded whatever was still checked BEHIND the
// filter — index 0 by default, a different and now-invisible station. Pure, so the rule is
// testable without a DOM (layers.js can't be imported under node).
//
//   visibleIdx      — indices still visible after filtering
//   checkedIdx      — index currently checked within the list, or null
//   externalChecked — an option OUTSIDE the list is chosen (Tentacles' "None — a miss")
//
// Returns the index that should end up checked, or null for "nothing — make them pick".
export function repairRadioSelection({ visibleIdx, checkedIdx = null, externalChecked = false }) {
  // A deliberate out-of-list choice is never overridden by filtering.
  if (externalChecked) return null;
  // The seeker can still see their choice: keep it.
  if (checkedIdx != null && visibleIdx.includes(checkedIdx)) return checkedIdx;
  // Their choice is hidden (or absent). One visible match is unambiguous — that is what
  // the filter implies. Otherwise clear it and require an explicit pick.
  return visibleIdx.length === 1 ? visibleIdx[0] : null;
}

// A small single-field text prompt as a bottom sheet. Resolves to the string or null.
export function promptText({ title, label = "", value = "", placeholder = "", cta = "Save", mapInteractive = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const s = openSheet({
      title,
      mapInteractive,
      bodyHTML: `
        ${label ? `<label class="fieldlbl">${escapeHtml(label)}</label>` : ""}
        <input id="pt-input" class="field" type="text" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" />
        <div class="sheet-actions">
          <button id="pt-cancel" class="btn btn-ghost">Cancel</button>
          <button id="pt-ok" class="btn btn-primary">${escapeHtml(cta)}</button>
        </div>`,
      onClose: () => { if (!done) resolve(null); },
    });
    const input = s.q("#pt-input");
    input.focus();
    input.select?.();
    s.q("#pt-ok").onclick = () => { done = true; const v = input.value.trim(); s.close(); resolve(v); };
    s.q("#pt-cancel").onclick = () => s.close();
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") s.q("#pt-ok").click(); });
  });
}

// Plural form of a card label, for "tick the {things} that count" copy.
//
// Card labels are inconsistent BY DESIGN: the Tentacles cards are already plural ("Museums",
// "Libraries") because the card reads as a set, while the Matching and Measuring cards are
// singular ("Museum", "Golf Course") because they read as one thing. The sheets appended "s"
// to whatever they were given, which was right for half the deck and gave "museumss" for the
// other half. Custom library categories are user-named, so they can be either.
//
// Deliberately shallow: it decides "does this already end in a plural s", and otherwise applies
// the two rules that cover the deck (consonant + y -> -ies, sibilant -> -es). This is NOT a
// general English pluraliser and should not grow into one — a label needing an irregular plural
// should carry an explicit one on the card instead.
export function pluralLabel(label) {
  const s = String(label ?? "").trim();
  if (!s) return s;
  // Already plural: "Museums", "Libraries", "Metro Lines". "Landmass" is not — hence the ss.
  if (/[^s]s$/i.test(s)) return s;
  if (/[^aeiou]y$/i.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(s)) return `${s}es`;
  return `${s}s`;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
