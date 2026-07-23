// Phase 38 (Stage 4): in-app Guide.
//
// The tool has grown well past what the original "How to play" sheet covers —
// a locked station set with map interactions, a live seeker↔hider location
// channel, and a small family of proximity alerts. This Guide is the reference
// for those, split into labelled sections. The Android section below is the
// off-device fallback copy: on the native shell, Phase 45's games.js replaces it
// with a LIVE permissions setup wizard (src/native-permissions.js) that detects
// each grant and deep-links to the exact settings screen. In the browser/PWA
// (no grants to detect) this honest "here's what background alerts will need"
// text stays.
//
// The sections are data (pure `guideSections()` / `guideBodyHTML()`), so the
// content is unit-tested without a DOM and games.js just drops the HTML into a
// sheet.

export const GUIDE_SECTIONS = [
  {
    id: "questions",
    title: "❓ Question tools",
    html: `
      <p class="muted">Each question shades out where the hider <em>isn't</em>; the green outline is the still-possible area.</p>
      <ul>
        <li><strong>◎ Radar / 🌡 Thermometer</strong> — “within X of here?” and “warmer or colder A→B?”.</li>
        <li><strong>🧭 Matching / 📐 Measuring</strong> — the game's 20 cards; reveal the hider's value and the map keeps the matching (or within/beyond) region.</li>
        <li><strong>🐙 Tentacles</strong> — pick the fixed-radius feature the hider is closest to.</li>
        <li><strong>🗺 Admin check</strong> — compare two points' administrative divisions (a reasoning aid; doesn't shade).</li>
      </ul>
      <p class="muted">The full per-tool walkthrough is in <strong>Settings ▸ 📖 Instructions</strong>.</p>`,
  },
  {
    id: "stations",
    title: "🚉 Stations",
    html: `
      <p class="muted">Lock in the board's stations once (☰ menu ▸ 🚉 Stations, from OSM or Google Places); line-, range- and name-length questions all refer to that set.</p>
      <ul>
        <li><strong>Long-press a station</strong> (or right-click on desktop) for a chooser: 📝 add a note, or ❌ eliminate / ♻️ restore it. A plain tap does nothing, so you can't rule one out by accident.</li>
        <li><strong>📍 Add stations (tap map)</strong> (in the Stations panel) drops a pin wherever you tap — keep tapping to add more, then Done. Use it when a real station doesn't show up from OSM/Places; no name needed.</li>
      </ul>`,
  },
  {
    id: "live-share",
    title: "📡 Live location share",
    html: `
      <p class="muted">A one-way channel (no game state): the SEEKER's device streams its GPS to the HIDER's device. Exchange the 6-character session code out of band, then one shares as SEEKER and one receives as HIDER.</p>
      <ul>
        <li>The hider sees a <strong>red dot</strong> jump to the seeker's latest position each update, plus a pill with the live distance.</li>
        <li>Your own position always shows as a <strong>blue dot</strong> with an accuracy ring, and a <strong>📍 Location on</strong> chip appears whenever the app is using GPS.</li>
      </ul>`,
  },
  {
    id: "alerts",
    title: "🔔 Alerts & notifications",
    html: `
      <p class="muted">Two proximity alerts, both fired locally on your phone:</p>
      <ul>
        <li><strong>Edge alert</strong> (hider) — warns you as you near, or cross, the edge of your Hider zone. Set the distance in the 🎯 Hider-zone panel (or Settings). Fires once per crossing, not every minute.</li>
        <li><strong>Seeker-close alert</strong> (hider) — fires when a live-shared seeker gets within your chosen threshold of your zone centre (500 m / 1 / 2 / 5 km, or a custom km).</li>
        <li><strong>Alert style</strong> (Settings) applies to both: Off (no notification at all), Silent (notification only), Vibrate, or Vibrate + tone. The on-screen pill updates either way.</li>
      </ul>`,
  },
  {
    id: "android",
    title: "📲 Background alerts (Android)",
    html: `
      <p class="warn-note">⚠️ In the web app, alerts only fire while the app is open. For alerts while your phone is locked in a pocket, install the Android app.</p>
      <p class="muted">Background alerts will need two Android permissions that are easy to miss: <strong>“Allow all the time”</strong> location, and a <strong>battery-optimization exemption</strong>. A setup wizard here will detect which are granted and link straight to the right settings screen once the Android app is installed.</p>`,
  },
];

// The sections, for callers that want to render or test them individually.
export function guideSections() {
  return GUIDE_SECTIONS;
}

// The full sheet body — a <section> per guide entry plus a close button.
export function guideBodyHTML() {
  const sections = GUIDE_SECTIONS.map(
    (s) => `<section id="guide-${s.id}"><h3 class="sub">${s.title}</h3>${s.html}</section>`,
  ).join("");
  return `<div class="guide">${sections}
    <div class="sheet-actions"><button id="guide-close" class="btn btn-primary">Got it</button></div>
  </div>`;
}
