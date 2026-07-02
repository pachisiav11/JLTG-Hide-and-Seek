// Lightweight UI primitives shared across the app: toasts and bottom sheets.

let activeSheet = null;

export function toast(msg, ms = 2400) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), ms);
}

// Open a bottom sheet. `bodyHTML` is inserted into the content area; the returned
// object exposes the root element, a query helper, and a close() fn.
export function openSheet({ title, bodyHTML = "", onClose } = {}) {
  closeSheet();
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop";

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

  backdrop.addEventListener("click", close);
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

// A small single-field text prompt as a bottom sheet. Resolves to the string or null.
export function promptText({ title, label = "", value = "", placeholder = "", cta = "Save" } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const s = openSheet({
      title,
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

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
