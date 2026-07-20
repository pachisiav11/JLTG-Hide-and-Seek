// Phase 5 (A2): parse a seeker's location out of whatever the hider pasted from
// WhatsApp. Playtest 1's systemic pain 2 recorded that seekers dropped their live
// location, radar centres, and thermometer endpoints into WhatsApp and the hider
// then had to transcribe them into the app. That "transcribe" step is the miss —
// it drops digits, mixes up lat/lng order, and gets skipped when the seeker is
// two messages ahead. This module accepts three intake shapes so the hider can
// paste whatever the WhatsApp message contained without pre-formatting it.
//
// The three shapes, from cheapest to WhatsApp-friendliest:
//
//   1. Bare coordinates:      "19.15, 72.85"  |  "19.15 72.85"  |  "-19.15,72.85"
//   2. Google Maps place URL: ".../@19.15,72.85,15z/..."  or  "?q=19.15,72.85"
//   3. WhatsApp text form:    "https://maps.google.com/maps?q=19.15,72.85"
//
// Short-URL forms (`https://maps.app.goo.gl/xyz`) can't be resolved without a
// network round trip and are out of scope here (they need HEAD-follow logic + a
// CORS-clean proxy). Returns `null` when nothing parses so the caller can toast a
// clear "couldn't read those coordinates" message instead of silently accepting
// zero. This is a pure function so it stays testable and doesn't reach into the DOM.

const LAT_RE = "(-?\\d{1,2}(?:\\.\\d+)?)";
const LNG_RE = "(-?\\d{1,3}(?:\\.\\d+)?)";
// Two forms of the maps URL fragment:
//   @lat,lng,zoom   — the /maps/place/... form
//   q=lat,lng       — the /maps?q=... form or share URL
const AT_RE = new RegExp(`[@\\/]${LAT_RE},${LNG_RE}(?:[,z]|$)`);
const Q_RE = new RegExp(`[?&]q=${LAT_RE},${LNG_RE}(?:[&]|$)`);
// Fallback: raw pair separated by comma or whitespace, anywhere in the string.
// Requires at least one digit after a decimal on ONE of them — a lone "19 72" is
// ambiguous (a version tag? a room number?) and this feature should refuse
// rather than eliminate ground somewhere in the Indian Ocean.
const PAIR_RE = new RegExp(`(?:^|[^\\d.-])${LAT_RE}[,\\s]+${LNG_RE}(?:[^\\d.]|$)`);

function inRange(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// Returns { lat, lng, source } on success, null on failure. `source` names which
// pattern matched so the caller (and the eventual "how did I get this coordinate"
// debug view) can report it honestly.
export function parseSeekerLocation(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  // Google Maps URL forms first — they're the most specific patterns and
  // preferring them avoids the pair regex matching a coordinate that happens to
  // appear as text elsewhere in the message (a distance readout, a time stamp).
  let m = t.match(AT_RE);
  if (m) {
    const lat = Number(m[1]), lng = Number(m[2]);
    if (inRange(lat, lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, source: "gmaps-at" };
  }
  m = t.match(Q_RE);
  if (m) {
    const lat = Number(m[1]), lng = Number(m[2]);
    if (inRange(lat, lng)) return { lat, lng, source: "gmaps-q" };
  }
  m = t.match(PAIR_RE);
  if (m) {
    const lat = Number(m[1]), lng = Number(m[2]);
    // Require at least one decimal point in the pair — an integer pair like
    // "19 72" is too ambiguous to trust as coordinates and would silently
    // resolve to a random point in Mumbai's sea. This is the same "prefer to
    // refuse than to guess" stance the elimination engine takes on unreadable
    // answer sides.
    if (!/\./.test(m[1]) && !/\./.test(m[2])) return null;
    if (inRange(lat, lng)) return { lat, lng, source: "pair" };
  }
  return null;
}
