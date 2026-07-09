// Minimal, dependency-free i18n scaffolding (Phase 12) — cniehaus's pattern: plain
// JS translation objects (langs/xx.js) plus a t()/tf() helper. English only for now;
// the app UI is not yet routed through these (adding a second language is a future
// need, not a current one — see IMPROVEMENTS.md Phase 12). This module exists so that
// wiring a language later is a drop-in, not a refactor.
//
// Usage once wired:
//   import { t, tf } from "./i18n.js";
//   el.textContent = t("questions.title");
//   toast(tf("zones.area", { size: "12 km²", tier: "Medium" }));
import en from "./langs/en.js";

// Registry of available languages. Add e.g. `fr: () => import("./langs/fr.js")` and
// they load on demand. English is bundled since it's the fallback.
const DICTS = { en };

const LS_KEY = "jltg.lang";
let current = "en";

export function getLang() {
  return current;
}

// Switch language. If the dictionary isn't loaded yet, this is a no-op for now
// (only English is bundled); left here so future langs slot in without API changes.
export function setLang(code) {
  if (DICTS[code]) { current = code; try { localStorage.setItem(LS_KEY, code); } catch (_) {} }
  return current;
}

// Translate a key; falls back to English, then to the raw key so nothing renders blank.
export function t(key) {
  const dict = DICTS[current] || en;
  return dict[key] ?? en[key] ?? key;
}

// Translate + interpolate {name} placeholders from `vars`.
export function tf(key, vars = {}) {
  return String(t(key)).replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

// Restore the saved language on load (defaults to English).
try {
  const saved = localStorage.getItem(LS_KEY);
  if (saved && DICTS[saved]) current = saved;
} catch (_) { /* ignore */ }
