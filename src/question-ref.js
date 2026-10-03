// The seekers' REFERENCE for a question, as text the hider can paste into their own phone.
//
// Playtest 2: the seekers asked the Coastline question against a line they had drawn
// themselves. The hiders answered against the coast Google Maps shows them, which is not that
// line — and knowing the seekers were "using a custom line" did not help, because nobody on the
// hiders' side could see it. The answer was wrong in a way neither team could detect.
//
// Every question whose answer depends on a set the SEEKERS chose — a line or region they drew,
// a list of POIs they ticked — has the same failure mode. This module turns that set into text
// that travels over the group chat, and back into the same set on the hider's phone.
//
// Shareable ("custom") references, by the players' own rule:
//   - every hand-drawn line, region or area;
//   - every ticked POI list (auto-found then ticked, or placed by hand — the seekers chose it,
//     and the hider's Google Maps can never reproduce that exact set).
// NOT shareable: lines auto-sourced from OpenStreetMap (Measuring's sourced coastline / borders /
// high-speed rail, Matching's sourced transit lines, Tentacles' Metro Lines). Those are the same
// query on both phones by construction.
//
// Wire format: a GeoJSON FeatureCollection with a `jltg` foreign member, preceded by ONE line of
// plain English, so a hider who receives a blob in WhatsApp is told what to do with it. The
// parser skips any text before the first "{", so the whole message can be pasted as-is.
//
// What travels, per question (all of it from the seeker's own input — nothing here is derived):
//   - the reference itself (POIs numbered as on the seeker's map, lines, polygons);
//   - the SEEKERS' SIDE where the question is relative to them: their distance (Measuring), the
//     POI / line they are nearest to or the name length of their station (Matching), the region
//     they drew as theirs (Matching region, Sea Level);
//   - for Tentacles, the seekers' position and the card's reach.
// The hider's ANSWER never travels — it is not known yet, and a committed step's answer is not
// copied out of it either.
//
// Pure: no DOM, no map, no turf. Distances for the hider's measure aid live in measure-aid.js.

export const REF_KIND = "question-ref";
export const REF_VERSION = 1;

const TOOL_LABEL = { measuring: "Measuring", matching: "Matching", tentacles: "Tentacles" };
const DP = 6; // ~0.1 m, the same precision as the play-area export
const fix = (n) => Number(Number(n).toFixed(DP));

// Hard ceilings on what a pasted reference may contain. Generous for any real question (a
// ticked POI list is tens of entries, a drawn line tens of taps), and there so a pasted
// megabyte of junk is refused with a message rather than freezing the hider's phone.
const MAX_FEATURES = 2000;
const MAX_VERTICES = 50000;

// ---- What can be shared ---------------------------------------------------------------------

// The variant of a question, from its tool + inputs. One name per shape of reference.
export function refVariant(tool, inputs) {
  const i = inputs || {};
  if (tool === "measuring") return ["points", "line", "area", "region"].includes(i.refType) ? i.refType : null;
  if (tool === "matching") return ["nearest", "nameLength", "stationLine", "nearestLine", "region"].includes(i.mode) ? i.mode : null;
  if (tool === "tentacles") {
    if (Array.isArray(i.lines) && i.lines.length) return "lines";
    return Array.isArray(i.features) ? "points" : null;
  }
  return null;
}

/**
 * True when the question's reference was chosen by the seekers and is worth sending to the
 * hider. False for OSM-sourced lines (identical on both phones by construction) and for tools
 * with no reference set at all (Radar, Thermometer).
 */
export function isCustomReference(tool, inputs) {
  const v = refVariant(tool, inputs);
  if (!v) return false;
  const i = inputs || {};
  if (tool === "measuring") {
    if (v === "line") return i.refSource !== "osm" && !!i.refGeometry;
    if (v === "points") return !!i.refGeometry;
    if (v === "area") return !!i.refGeometry;
    return Array.isArray(i.ring) && i.ring.length >= 3;
  }
  if (tool === "matching") {
    if (v === "nearestLine") return i.source !== "osm" && Array.isArray(i.lines) && i.lines.length > 0;
    if (v === "region") return Array.isArray(i.ring) && i.ring.length >= 3;
    if (v === "stationLine") return Array.isArray(i.stations) && i.stations.length > 0;
    return Array.isArray(i.features) && i.features.length > 0;
  }
  // Tentacles: a ticked POI list is custom; Metro Lines are sourced.
  return v === "points" && Array.isArray(i.features) && i.features.length > 0;
}

export function isShareableStep(step) {
  return !!step && isCustomReference(step.tool, step.inputs);
}

// ---- Building ------------------------------------------------------------------------------

const pt = (lat, lng) => ({ type: "Point", coordinates: [fix(lng), fix(lat)] });
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const okLatLng = (lat, lng) => finite(lat) && finite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

// [lat,lng] ring → closed GeoJSON ring
function closedRing(ring) {
  const r = (ring || []).filter((p) => Array.isArray(p) && okLatLng(p[0], p[1])).map(([lat, lng]) => [fix(lng), fix(lat)]);
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push([...r[0]]);
  return r;
}

// Every path of a Matching line, whether hand-drawn ({coords:[{lat,lng}]}) or carrying paths
// ([[lat,lng]]). Same normalisation as tools.js linePaths, duplicated so this module stays
// importable without turf.
function linePathsOf(ln) {
  const raw = Array.isArray(ln?.paths) ? ln.paths : Array.isArray(ln?.coords) ? [ln.coords] : [];
  return raw
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map((p) => p.map((c) => (Array.isArray(c) ? [c[0], c[1]] : [c?.lat, c?.lng])).filter(([a, b]) => okLatLng(a, b)))
    .filter((p) => p.length >= 2);
}

const poiFeature = (f, n) => ({
  type: "Feature",
  properties: { role: "poi", n, name: String(f?.name || `#${n}`) },
  geometry: pt(f.lat, f.lng),
});

// The card a question was asked from. Measuring steps saved before `refCard` existed carry only
// the label; the id is then left null and the label still names the question.
function cardOf(tool, inputs) {
  const i = inputs || {};
  if (tool === "measuring") return { id: i.refCard || null, label: i.refLabel || "Reference" };
  return { id: i.category || null, label: i.categoryLabel || i.category || "Question" };
}

/**
 * Build the reference FeatureCollection for a question.
 *
 *   tool    — "measuring" | "matching" | "tentacles"
 *   inputs  — the step inputs exactly as layers.js commits them
 *   seeker  — the SEEKERS' side, as the seeker entered it (see `seekerFromStep` for the shape)
 *
 * Throws with a player-facing message when the question has nothing shareable.
 */
export function buildQuestionRef({ tool, inputs, seeker = {}, sentAt = Date.now() } = {}) {
  if (!isCustomReference(tool, inputs)) {
    throw new Error("This question's reference is looked up automatically on both phones — there's nothing custom to send.");
  }
  const variant = refVariant(tool, inputs);
  const i = inputs;
  const card = cardOf(tool, i);
  const features = [];

  if (tool === "measuring") {
    if (variant === "points") {
      const pts = Array.isArray(i.refFeatures) && i.refFeatures.length
        ? i.refFeatures
        : geojsonPoints(i.refGeometry).map(([lng, lat], k) => ({ lat, lng, name: `${card.label} ${k + 1}` }));
      pts.forEach((f, k) => { if (okLatLng(f.lat, f.lng)) features.push(poiFeature(f, k + 1)); });
    } else if (variant === "line") {
      features.push({ type: "Feature", properties: { role: "line", id: "ln_0", name: card.label }, geometry: roundGeometry(i.refGeometry) });
    } else if (variant === "area") {
      features.push({ type: "Feature", properties: { role: "area", name: card.label }, geometry: roundGeometry(i.refGeometry) });
    } else {
      features.push({ type: "Feature", properties: { role: "region", name: `Seekers' side of the ${card.label.toLowerCase()} boundary` }, geometry: { type: "Polygon", coordinates: [closedRing(i.ring)] } });
    }
  } else if (tool === "matching") {
    if (variant === "nearest" || variant === "nameLength") {
      i.features.forEach((f, k) => { if (okLatLng(f.lat, f.lng)) features.push(poiFeature(f, k + 1)); });
    } else if (variant === "stationLine") {
      i.stations.forEach((f, k) => { if (okLatLng(f.lat, f.lng)) features.push(poiFeature(f, k + 1)); });
    } else if (variant === "nearestLine") {
      i.lines.forEach((ln, k) => {
        const paths = linePathsOf(ln).map((p) => p.map(([lat, lng]) => [fix(lng), fix(lat)]));
        if (!paths.length) return;
        features.push({
          type: "Feature",
          properties: { role: "line", id: String(ln.id ?? `ln_${k}`), name: String(ln.label || `Line ${k + 1}`) },
          geometry: paths.length === 1 ? { type: "LineString", coordinates: paths[0] } : { type: "MultiLineString", coordinates: paths },
        });
      });
    } else {
      features.push({ type: "Feature", properties: { role: "region", name: `Seekers' ${card.label}` }, geometry: { type: "Polygon", coordinates: [closedRing(i.ring)] } });
    }
  } else {
    i.features.forEach((f, k) => { if (okLatLng(f.lat, f.lng)) features.push(poiFeature(f, k + 1)); });
  }

  const jltg = {
    kind: REF_KIND, v: REF_VERSION,
    tool, variant,
    card: card.id, label: card.label,
    title: `${TOOL_LABEL[tool]} · ${card.label}`,
    sentAt: new Date(sentAt).toISOString(),
    seeker: cleanSeeker(tool, variant, seeker, features),
  };
  if (tool === "tentacles") {
    if (i.center && okLatLng(i.center.lat, i.center.lng)) jltg.center = { lat: fix(i.center.lat), lng: fix(i.center.lng) };
    if (finite(i.radius) && i.radius > 0) jltg.radiusM = Math.round(i.radius);
  }
  if (variant === "stationLine") {
    if (i.lineLabel) jltg.lineLabel = String(i.lineLabel);
    if (finite(i.radiusM) && i.radiusM > 0) jltg.hidingRadiusM = Math.round(i.radiusM);
  }
  return { type: "FeatureCollection", jltg, features };
}

function geojsonPoints(g) {
  if (!g) return [];
  if (g.type === "Point") return [g.coordinates];
  if (g.type === "MultiPoint") return g.coordinates || [];
  return [];
}

// Round a GeoJSON line/polygon geometry's coordinates to the wire precision.
function roundGeometry(g) {
  const r = (c) => (Array.isArray(c) && typeof c[0] === "number" ? [fix(c[0]), fix(c[1])] : (c || []).map(r));
  return { type: g.type, coordinates: r(g.coordinates) };
}

// Keep only the seeker fields that mean something for this variant, and only when valid.
// A seeker block with junk in it would print junk on the hider's phone, which is worse than
// printing nothing.
function cleanSeeker(tool, variant, seeker, features) {
  const s = seeker || {};
  const out = {};
  if (tool === "measuring" && variant !== "region") {
    if (finite(s.distanceM) && s.distanceM > 0) out.distanceM = Math.round(s.distanceM * 10) / 10;
  } else if (tool === "matching" && (variant === "nearest")) {
    const n = Math.round(s.nearest);
    if (finite(n) && n >= 1 && n <= features.length) out.nearest = n;
  } else if (tool === "matching" && variant === "nameLength") {
    const L = Math.round(s.nameLength);
    if (finite(L) && L > 0) out.nameLength = L;
  } else if (tool === "matching" && variant === "nearestLine") {
    const id = s.nearestLine == null ? null : String(s.nearestLine);
    if (id && features.some((f) => f.properties.id === id)) out.nearestLine = id;
  }
  // Region variants: the polygon IS the seekers' side. Station's Line: `lineLabel` is the side.
  // Tentacles: the question is "which are YOU closest to" — nothing on the seekers' side.
  return out;
}

/**
 * The seekers' side of a COMMITTED question, read from its inputs and answer.
 *
 * Only the fields the seeker entered about themselves. `keep` / `match` / `side` / `inside` are
 * the HIDER's answer and are never read here.
 */
export function seekerFromStep(step) {
  const i = step?.inputs || {}, a = step?.answer || {};
  const v = refVariant(step?.tool, i);
  if (step?.tool === "measuring" && v !== "region") return { distanceM: i.distance };
  if (step?.tool === "matching") {
    if (v === "nearest" && Number.isInteger(a.featureIndex)) return { nearest: a.featureIndex + 1 };
    if (v === "nameLength" && finite(a.length)) return { nameLength: a.length };
    if (v === "nearestLine" && a.lineId != null) return { nearestLine: a.lineId };
  }
  return {};
}

export function refFromStep(step, opts = {}) {
  return buildQuestionRef({ tool: step.tool, inputs: step.inputs, seeker: seekerFromStep(step), ...opts });
}

/** The message to paste into the group chat: one plain-English line, then the JSON. */
export function questionRefText(fc) {
  return `JLTG question for the hider — ${fc.jltg.title}. Paste this whole message into Questions ▸ 📥 Received question.\n${JSON.stringify(fc)}`;
}

// ---- Parsing (the hider's side) -------------------------------------------------------------

/**
 * Parse pasted text back into a normalised reference. Throws an Error whose message is meant
 * for the player.
 *
 * Validated rather than trusted, like a share link: it arrives through a chat app that may have
 * truncated it, and a reference that loads with half its POIs missing is worse than one that is
 * refused — the hider would answer against a set that is not the seekers' set, which is the very
 * failure this exists to remove.
 */
export function parseQuestionRef(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Nothing pasted — copy the seekers' whole message and paste it here.");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("That isn't a question from the seekers — ask them to send it again with 📤 Copy for hider.");
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); }
  catch { throw new Error("The message looks cut off or edited — ask the seekers to copy it again."); }

  const meta = obj?.jltg;
  if (meta?.kind === "play-area") throw new Error("This is a play area, not a question — paste it in Zones ▸ ⇩ Import area.");
  if (!meta || meta.kind !== REF_KIND) throw new Error("That isn't a question from the seekers — ask them to send it again with 📤 Copy for hider.");
  if (meta.v !== REF_VERSION) throw new Error(`This was sent by a different version of the app (format ${meta.v}). Both phones should reload the app.`);
  if (!TOOL_LABEL[meta.tool]) throw new Error("This question type isn't one this app knows.");
  const variant = meta.variant;
  if (refVariantKnown(meta.tool, variant) === false) throw new Error("This question type isn't one this app knows.");
  if (obj.type !== "FeatureCollection" || !Array.isArray(obj.features)) throw new Error("The message looks cut off or edited — ask the seekers to copy it again.");
  if (obj.features.length > MAX_FEATURES) throw new Error(`This reference has ${obj.features.length} items — too many to be a real question.`);

  const pois = [], lines = [], polygons = [];
  let vertices = 0;
  const bad = () => { throw new Error("The message has a broken coordinate — ask the seekers to copy it again."); };
  for (const f of obj.features) {
    const g = f?.geometry, p = f?.properties || {};
    if (!g || typeof g.type !== "string") bad();
    if (p.role === "poi") {
      if (g.type !== "Point") bad();
      const [lng, lat] = g.coordinates || [];
      if (!okLatLng(lat, lng)) bad();
      const n = Number.isInteger(p.n) && p.n > 0 ? p.n : pois.length + 1;
      pois.push({ n, name: String(p.name || `#${n}`).slice(0, 200), lat, lng });
      vertices++;
    } else if (p.role === "line") {
      const paths = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : null;
      if (!Array.isArray(paths) || !paths.length) bad();
      const out = paths.map((path) => {
        if (!Array.isArray(path) || path.length < 2) bad();
        return path.map((c) => { const [lng, lat] = c || []; if (!okLatLng(lat, lng)) bad(); vertices++; return { lat, lng }; });
      });
      lines.push({ id: String(p.id ?? `ln_${lines.length}`), name: String(p.name || `Line ${lines.length + 1}`).slice(0, 200), paths: out });
    } else if (p.role === "area" || p.role === "region") {
      const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : null;
      if (!Array.isArray(polys) || !polys.length) bad();
      for (const poly of polys) {
        const outer = Array.isArray(poly) ? poly[0] : null;
        if (!Array.isArray(outer) || outer.length < 4) bad();
        const ring = outer.map((c) => { const [lng, lat] = c || []; if (!okLatLng(lat, lng)) bad(); vertices++; return [lat, lng]; });
        ring.pop(); // stored open, like zones
        polygons.push({ role: p.role, name: String(p.name || "").slice(0, 200), ring });
      }
    }
    // Unknown roles are ignored rather than refused: a newer app may add decorations.
  }
  if (vertices > MAX_VERTICES) throw new Error("This reference is too large to be a real question.");
  if (!pois.length && !lines.length && !polygons.length) throw new Error("This message has no line or places in it — ask the seekers to copy it again.");
  pois.sort((a, b) => a.n - b.n);

  const ref = {
    tool: meta.tool,
    variant,
    card: typeof meta.card === "string" ? meta.card : null,
    label: String(meta.label || "Question").slice(0, 120),
    title: String(meta.title || `${TOOL_LABEL[meta.tool]} · ${meta.label || ""}`).slice(0, 160),
    sentAt: typeof meta.sentAt === "string" ? meta.sentAt : null,
    pois, lines, polygons,
    seeker: {},
  };
  const s = meta.seeker || {};
  if (finite(s.distanceM) && s.distanceM > 0) ref.seeker.distanceM = s.distanceM;
  if (Number.isInteger(s.nearest) && pois.some((q) => q.n === s.nearest)) ref.seeker.nearest = s.nearest;
  if (Number.isInteger(s.nameLength) && s.nameLength > 0) ref.seeker.nameLength = s.nameLength;
  if (s.nearestLine != null && lines.some((l) => l.id === String(s.nearestLine))) ref.seeker.nearestLine = String(s.nearestLine);
  if (meta.center && okLatLng(meta.center.lat, meta.center.lng)) ref.center = { lat: meta.center.lat, lng: meta.center.lng };
  if (finite(meta.radiusM) && meta.radiusM > 0) ref.radiusM = meta.radiusM;
  if (typeof meta.lineLabel === "string") ref.lineLabel = meta.lineLabel.slice(0, 120);
  if (finite(meta.hidingRadiusM) && meta.hidingRadiusM > 0) ref.hidingRadiusM = meta.hidingRadiusM;
  return ref;
}

function refVariantKnown(tool, variant) {
  const known = {
    measuring: ["points", "line", "area", "region"],
    matching: ["nearest", "nameLength", "stationLine", "nearestLine", "region"],
    tentacles: ["points"],
  };
  return (known[tool] || []).includes(variant);
}

/**
 * Cheap sniff for "this text is a seekers' question", for OTHER paste boxes to refuse it.
 *
 * Zones ▸ Import falls back to scraping numbers out of anything that is not JSON, so a question
 * pasted there would become a zone made of its coordinates — a board-wrecking mistake from a
 * one-box mix-up. Matching the marker rather than parsing keeps it working on a truncated paste.
 */
export function looksLikeQuestionRef(text) {
  return /"kind"\s*:\s*"question-ref"/.test(String(text || ""));
}

/**
 * Does a received reference belong to the question the hider has open? Used by the paste box
 * INSIDE a question flow, which must refuse a reference for a different question rather than
 * draw, say, a body of water while the hider thinks they are looking at the coastline.
 *
 * Matched on card id where both sides have one, else on the label (measuring steps saved before
 * card ids were recorded).
 */
export function refMatchesCard(ref, { tool, cardId = null, cardLabel = null } = {}) {
  if (!ref || ref.tool !== tool) return false;
  if (ref.card && cardId) return ref.card === cardId;
  return !!cardLabel && String(ref.label).toLowerCase() === String(cardLabel).toLowerCase();
}

/** One-line summary of what a reference contains, for both the seeker's preview and the hider. */
export function describeReference(ref) {
  const n = ref.pois?.length || 0, l = ref.lines?.length || 0, p = ref.polygons?.length || 0;
  const parts = [];
  if (n) parts.push(`${n} place${n === 1 ? "" : "s"}`);
  if (l) parts.push(l === 1 ? "1 line" : `${l} lines`);
  if (p) parts.push(p === 1 ? (ref.polygons[0].role === "area" ? "1 area" : "1 region") : `${p} regions`);
  return parts.join(", ");
}

/**
 * The seekers' side, in words. `fmt` formats metres for the reader's unit setting.
 * Returns "" when the question carries no seeker side (Tentacles).
 */
export function describeSeekerSide(ref, fmt = (m) => `${Math.round(m)} m`) {
  const s = ref.seeker || {};
  if (ref.tool === "measuring") {
    if (ref.variant === "region") return "The outlined region is the seekers' side of the boundary.";
    return finite(s.distanceM) ? `Seekers' distance to the nearest ${ref.label.toLowerCase()}: ${fmt(s.distanceM)}.` : "The seekers didn't include their distance.";
  }
  if (ref.tool === "matching") {
    if (ref.variant === "nearest") {
      const p = ref.pois.find((q) => q.n === s.nearest);
      return p ? `Seekers' nearest: #${p.n} ${p.name}.` : "The seekers didn't say which one is nearest to them.";
    }
    if (ref.variant === "nameLength") return finite(s.nameLength) ? `Seekers' nearest station name has ${s.nameLength} letters.` : "The seekers didn't include their name length.";
    if (ref.variant === "nearestLine") {
      const ln = ref.lines.find((x) => x.id === s.nearestLine);
      return ln ? `Seekers' nearest line: ${ln.name}.` : "The seekers didn't say which line is nearest to them.";
    }
    if (ref.variant === "stationLine") return `Seekers' nearest station is on ${ref.lineLabel || "this line"}${ref.hidingRadiusM ? ` · hiding radius ${fmt(ref.hidingRadiusM)}` : ""}.`;
    if (ref.variant === "region") return "The outlined region is the one the seekers are in.";
  }
  if (ref.tool === "tentacles" && ref.radiusM) return `Places within ${fmt(ref.radiusM)} of the seekers (circle).`;
  return "";
}
