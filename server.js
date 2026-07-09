// JLTG backend (Phase 10) — a small Express service hosted on Render as a Web
// Service, separate from the Static Site (map UI). Its only job today is a
// same-origin-friendly **Overpass proxy**: a FALLBACK for Places-category search
// when Google Places fails or is quota-exhausted (see IMPROVEMENTS.md Phase 10).
//
// Why a proxy and not client-side Overpass:
//   - sidesteps CORS friction with public Overpass instances,
//   - centralizes multi-endpoint retry/backoff server-side,
//   - keeps a single consistent origin for rate-limiting.
//
// This is NOT a replacement for Google Maps — the map engine stays Google. Overpass
// is only a backstop for the category point sets used by Matching/Measuring/Tentacles.
//
// Phase 13 note: this same Express app can later also host the Socket.IO relay, so
// there is one Node Web Service rather than two.

import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// Public Overpass endpoints, tried in order with backoff. Any single instance can
// be rate-limited or down, so we keep a few (cniehaus and gelbh both do this).
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// Density-ladder step 1: broaden tag matching before assuming data is missing. Each
// category maps to several OSM tag alternatives so a thinly-tagged region still
// returns results. Keys mirror the Google place `type` / card ids used client-side.
const CATEGORY_TAGS = {
  hospital: [["amenity", "hospital"], ["healthcare", "hospital"], ["building", "hospital"]],
  park: [["leisure", "park"], ["leisure", "garden"]],
  museum: [["tourism", "museum"]],
  library: [["amenity", "library"]],
  movie_theater: [["amenity", "cinema"]],
  zoo: [["tourism", "zoo"]],
  aquarium: [["tourism", "aquarium"]],
  amusement_park: [["tourism", "theme_park"], ["leisure", "water_park"]],
  train_station: [["railway", "station"]],
  subway_station: [["station", "subway"], ["railway", "station"]],
  bus_station: [["amenity", "bus_station"]],
  airport: [["aeroway", "aerodrome"]],
  school: [["amenity", "school"]],
  place_of_worship: [["amenity", "place_of_worship"]],
  tourist_attraction: [["tourism", "attraction"]],
  restaurant: [["amenity", "restaurant"]],
  shopping_mall: [["shop", "mall"]],
  golf: [["leisure", "golf_course"]],
  mountain: [["natural", "peak"]],
  consulate: [["office", "diplomatic"], ["amenity", "embassy"]],
};

// CORS: allow the static site to call us cross-origin. Set ALLOW_ORIGIN to your
// *.onrender.com static-site URL in production; defaults to "*".
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// GET /overpass?category=hospital&bbox=S,W,N,E   (bbox = south,west,north,east)
// Optional &keyword=foo to name-filter results. Returns { source, features:[{name,lat,lng}] }.
app.get("/overpass", async (req, res) => {
  const category = String(req.query.category || "");
  const tags = CATEGORY_TAGS[category];
  if (!tags) return res.status(400).json({ error: `Unknown category "${category}".` });

  const parts = String(req.query.bbox || "").split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return res.status(400).json({ error: "bbox must be S,W,N,E (four numbers)." });
  }
  const [s, w, n, e] = parts;
  const bbox = `${s},${w},${n},${e}`;
  const keyword = String(req.query.keyword || "").trim().toLowerCase();

  const query = buildQuery(tags, bbox);
  try {
    const json = await runOverpass(query);
    let features = normalize(json);
    if (keyword) features = features.filter((f) => f.name.toLowerCase().includes(keyword));
    res.json({ source: "overpass", count: features.length, features });
  } catch (err) {
    console.error("Overpass proxy failed:", err.message);
    res.status(502).json({ error: "All Overpass endpoints failed.", detail: err.message });
  }
});

function buildQuery(tags, bbox) {
  const lines = [];
  for (const [k, v] of tags) {
    for (const el of ["node", "way", "relation"]) {
      lines.push(`  ${el}["${k}"="${v}"](${bbox});`);
    }
  }
  return `[out:json][timeout:25];\n(\n${lines.join("\n")}\n);\nout center tags;`;
}

// Try each endpoint in turn with exponential backoff between attempts.
async function runOverpass(query) {
  let lastErr;
  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
    const url = OVERPASS_ENDPOINTS[i];
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
      return await resp.json();
    } catch (err) {
      lastErr = err;
      if (i < OVERPASS_ENDPOINTS.length - 1) await sleep(500 * (i + 1)); // 0.5s, 1s backoff
    }
  }
  throw lastErr || new Error("no endpoints");
}

// Overpass elements → [{name,lat,lng}]. node has lat/lon; way/relation have center.
function normalize(json) {
  const out = [];
  const seen = new Set();
  for (const el of json.elements || []) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    const name = el.tags?.name || el.tags?.["name:en"] || "(unnamed)";
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    if (seen.has(key)) continue; // de-dupe node/way/relation of the same feature
    seen.add(key);
    out.push({ name, lat, lng });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.listen(PORT, () => console.log(`JLTG backend listening on :${PORT} (Overpass proxy at /overpass)`));
