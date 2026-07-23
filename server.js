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

import express from "express";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { runOverpass, OVERPASS_ENDPOINTS, OVERPASS_PASSES } from "./overpass.js";
import { buildLinesQuery, normalizeLines, bboxIsValid, LINE_KINDS, DEFAULT_BORDER_LEVEL, buildCountryQuery, countryNameFromQuery, COUNTRY_DIVISION_LEVELS } from "./overpass-lines.js";
import { buildStationsQuery, normalizeStations } from "./overpass-stations.js";
import { isValidLocationPayload, allowShareLocation } from "./share-location.js";
import { HiderTokenRegistry } from "./hider-tokens.js";
import { createFcm } from "./fcm.js";

const app = express();
const PORT = process.env.PORT || 3000;


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
  // Google's catch-all transit type, used by the Station's Name Length card. Without this
  // the card had no Overpass mapping at all, so it stayed capped at Google's 60 stations
  // for the whole board and partitioned from an arbitrary subset (B3).
  transit_station: [["railway", "station"], ["railway", "halt"], ["station", "subway"], ["amenity", "bus_station"]],
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
  // /overpass/lines has validated its bbox since it was written; this endpoint only checked
  // that four numbers parsed. Four numbers is not a box: swapped corners (S>N) match nothing,
  // and out-of-range values are rejected by Overpass as a 400 that this proxy then reports as
  // "Overpass rejected the query" — pointing at a query bug in this file rather than at the
  // caller's parameters. Same rule, same message, one place to change it.
  if (!bboxIsValid(bbox)) {
    return res.status(400).json({ error: "bbox must be S,W,N,E with S<N, W<E and within ±90/±180." });
  }
  const keyword = String(req.query.keyword || "").trim().toLowerCase();

  const query = buildQuery(tags, bbox);
  try {
    const json = await runOverpass(query);
    let features = normalize(json);
    if (keyword) features = features.filter((f) => f.name.toLowerCase().includes(keyword));
    res.json({ source: "overpass", count: features.length, features });
  } catch (err) {
    // A malformed query is OUR bug and fails identically everywhere — report it as 400, not
    // as "all endpoints failed", which would send someone hunting a phantom outage.
    if (err.fatal) {
      console.error("Overpass query rejected (this is a query bug, not an outage):", err.message);
      return res.status(400).json({ error: "Overpass rejected the query.", detail: err.message });
    }
    console.error(`Overpass proxy failed after ${OVERPASS_PASSES} passes over ${OVERPASS_ENDPOINTS.length} endpoints:`, err.message);
    res.status(502).json({ error: "All Overpass endpoints failed (they were busy).", detail: err.message });
  }
});

// GET /overpass/lines?kind=rail|coastline|border&bbox=S,W,N,E[&level=2|4]
//
// The line counterpart to /overpass. That route hardcodes `out center tags`, which collapses
// every way to a centre point — right for POIs, useless for geometry — so lines need their own
// output mode rather than a flag on the old one.
//
// The join and the slimming happen HERE, not on the client: the Overpass answer carries ~93k
// member refs for Berlin to use ~19k of them, and none of that has any business crossing the
// wire to a phone.
app.get("/overpass/lines", async (req, res) => {
  const kind = String(req.query.kind || "");
  if (!LINE_KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of: ${LINE_KINDS.join(", ")}.` });
  }
  const bbox = String(req.query.bbox || "");
  if (!bboxIsValid(bbox)) {
    return res.status(400).json({ error: "bbox must be S,W,N,E with S<N, W<E and within ±90/±180." });
  }
  const level = req.query.level == null ? DEFAULT_BORDER_LEVEL : Number(req.query.level);
  if (!Number.isInteger(level) || level < 1 || level > 11) {
    return res.status(400).json({ error: "level must be an integer OSM admin_level (1-11)." });
  }

  try {
    const json = await runOverpass(buildLinesQuery(kind, bbox, { level }));
    const out = normalizeLines(kind, json);
    res.json({ source: "overpass", ...out });
  } catch (err) {
    if (err.badRequest) return res.status(400).json({ error: err.message });
    if (err.fatal) {
      console.error("Overpass rejected the lines query (query bug, not an outage):", err.message);
      return res.status(400).json({ error: "Overpass rejected the query.", detail: err.message });
    }
    console.error(`Overpass lines (${kind}) failed after ${OVERPASS_PASSES} passes over ${OVERPASS_ENDPOINTS.length} endpoints:`, err.message);
    res.status(502).json({ error: "All Overpass endpoints failed (they were busy).", detail: err.message });
  }
});

// GET /overpass/stations?bbox=S,W,N,E
//
// The station counterpart to /overpass/lines. Named stations only — an unnamed node is
// a question no player can answer, and deduping near-by same-name nodes collapses OSM's
// several taggings of one physical station down to one entry (see overpass-stations.js).
app.get("/overpass/stations", async (req, res) => {
  const bbox = String(req.query.bbox || "");
  if (!bboxIsValid(bbox)) {
    return res.status(400).json({ error: "bbox must be S,W,N,E with S<N, W<E and within ±90/±180." });
  }
  try {
    const json = await runOverpass(buildStationsQuery(bbox));
    const out = normalizeStations(json);
    res.json({ source: "overpass", ...out });
  } catch (err) {
    if (err.fatal) {
      console.error("Overpass rejected the stations query (query bug, not an outage):", err.message);
      return res.status(400).json({ error: "Overpass rejected the query.", detail: err.message });
    }
    console.error(`Overpass stations failed after ${OVERPASS_PASSES} passes over ${OVERPASS_ENDPOINTS.length} endpoints:`, err.message);
    res.status(502).json({ error: "All Overpass endpoints failed (they were busy).", detail: err.message });
  }
});

// What country the board is in, so a border card can look up its FIXED "1st/2nd division"
// admin_level (§5.6.1) — a nationwide constant, not something derived per board, because
// both players must be comparing the same kind of boundary. `country` is null and `levels`
// empty for a country outside the measured set; the card is meant to fall back, not guess.
app.get("/overpass/divisions", async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
    return res.status(400).json({ error: "lat/lon must be numbers within ±90/±180." });
  }
  try {
    const json = await runOverpass(buildCountryQuery(lat, lon));
    const country = countryNameFromQuery(json);
    res.json({ source: "overpass", country, levels: country ? (COUNTRY_DIVISION_LEVELS[country] || []) : [] });
  } catch (err) {
    if (err.fatal) {
      console.error("Overpass rejected the country query (query bug, not an outage):", err.message);
      return res.status(400).json({ error: "Overpass rejected the query.", detail: err.message });
    }
    console.error(`Overpass country lookup failed after ${OVERPASS_PASSES} passes over ${OVERPASS_ENDPOINTS.length} endpoints:`, err.message);
    res.status(502).json({ error: "All Overpass endpoints failed (they were busy).", detail: err.message });
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

// Phase 12 (§C5): a NARROW one-way relay for the seeker→hider live-location
// share. Not the Phase-13 full-multiplayer relay that was deleted 2026-07-18 —
// this carries ONE topic (a coordinate ping) in ONE direction (seeker → hider),
// no game state, no CRDT. The "no multiplayer" non-goal in PLAYTEST_IDEAS is
// partially rolled back for exactly this narrow slice (§C5 in the doc).
//
// Rooms are keyed by the session code the two devices exchange out of band
// (WhatsApp, verbal). A seeker joins with role=seeker and publishes GPS via
// `share-location`; a hider joins with role=hider and receives those pings on
// `location`. The server never stores locations — the last-seen point lives
// only in the hider's client memory. Broadcasts skip the publisher's own
// socket (`socket.to(room).emit`) so a device sharing to a room it also joined
// as a hider doesn't loop its own ping back.
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: ALLOW_ORIGIN, methods: ["GET", "POST"] },
});

// Phase 43 (Track B 2/3): native-push plumbing so a seeker-close alert can reach
// a LOCKED hider (Phase 44 forwards each ping over FCM). Both pieces DEGRADE
// GRACEFULLY — the Overpass proxy and the socket relay run identically whether or
// not FCM is configured. firebase-admin is an optional heavy dependency: import it
// lazily, and if it isn't installed the wrapper is simply disabled.
let firebaseAdmin = null;
try {
  firebaseAdmin = (await import("firebase-admin")).default;
} catch {
  console.log("[fcm] firebase-admin not installed — native push disabled (run `npm i firebase-admin` + set FIREBASE_SERVICE_ACCOUNT to enable).");
}
const fcm = createFcm({ admin: firebaseAdmin });
// sessionCode -> hider FCM token. No game state: a token is a delivery address,
// not a location. Entries expire (see hider-tokens.js) and a swept-prune runs hourly.
const hiderTokens = new HiderTokenRegistry();
setInterval(() => hiderTokens.prune(), 60 * 60 * 1000).unref?.();
io.on("connection", (socket) => {
  socket.data.room = null;
  socket.data.role = null;
  socket.on("join-session", ({ code, role } = {}) => {
    const room = typeof code === "string" ? code.trim().toLowerCase() : "";
    if (!room || !/^[a-z0-9-]{3,32}$/.test(room)) return socket.emit("session-error", "Invalid session code.");
    if (role !== "seeker" && role !== "hider") return socket.emit("session-error", "Role must be seeker or hider.");
    if (socket.data.room) socket.leave(socket.data.room);
    socket.data.room = room;
    socket.data.role = role;
    socket.join(room);
    socket.emit("session-joined", { room, role });
  });
  // Phase 43: a hider registers its FCM token against the session so the server
  // can push seeker-close alerts to it when locked. Accept only from a joined
  // hider on its own room; store the token on the socket too, so a disconnect
  // evicts exactly this token (never one a reconnected hider just refreshed).
  socket.on("register-token", ({ code, token } = {}) => {
    if (socket.data.role !== "hider" || !socket.data.room) return;
    const room = typeof code === "string" ? code.trim().toLowerCase() : "";
    if (room !== socket.data.room) return; // can only register for the room you joined
    if (hiderTokens.register(socket.data.room, token)) {
      socket.data.hiderToken = String(token).trim();
    }
  });
  socket.on("disconnect", () => {
    // Drop this hider's token on a clean disconnect so the server stops trying to
    // push to a session that has left.
    if (socket.data.role === "hider" && socket.data.room && socket.data.hiderToken) {
      hiderTokens.drop(socket.data.room, socket.data.hiderToken);
    }
  });
  socket.on("share-location", (payload) => {
    // Only accept publish from a joined seeker; ignore anything else silently
    // so a bad client can't spoof pings into someone else's session.
    if (socket.data.role !== "seeker" || !socket.data.room) return;
    if (!isValidLocationPayload(payload)) return;
    // Phase 19 (fix #7): token-bucket throttle. Silent drop past 4/s sustained
    // (6-token burst) — a legitimate 60-s cadence sits far under the limit;
    // a rogue client can no longer flood the hider or jitter across the
    // close-approach threshold to defeat the once-per-crossing debounce.
    if (!allowShareLocation(socket.data)) return;
    socket.to(socket.data.room).emit("location", {
      lat: payload.lat, lng: payload.lng, at: Date.now(),
    });
  });
});

httpServer.listen(PORT, () => console.log(`JLTG backend listening on :${PORT} (Overpass proxy /overpass, Socket.IO relay /socket.io)`));
