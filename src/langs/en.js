// English strings (Phase 12 i18n scaffolding). This is the reference dictionary and
// the fallback for every other language. The app currently ships English only — the
// UI is not yet routed through t()/tf() (that's a deliberate "skip unless there's an
// actual second-language need", per IMPROVEMENTS.md Phase 12). To add a language,
// copy this file to langs/xx.js, translate the values, and register it in i18n.js.
//
// Keys are dotted namespaces. `{n}`-style placeholders are filled by tf().
export default {
  "app.title": "JLTG · Hide & Seek",
  "tool.radar": "Radar",
  "tool.thermometer": "Thermometer",
  "tool.matching": "Matching",
  "tool.tentacles": "Tentacles",
  "tool.measuring": "Measuring",
  "questions.title": "Questions",
  "questions.empty": "No questions yet. Add one below.",
  "zones.title": "Zones",
  "zones.area": "Game area: {size} · {tier}",
  "settings.title": "Settings",
  "timer.timesUp": "Question time's up.",
  "update.available": "New version available.",
  "update.reload": "Reload",
};
