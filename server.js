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
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { runOverpass, OVERPASS_ENDPOINTS, OVERPASS_PASSES } from "./overpass.js";
import { buildLinesQuery, normalizeLines, bboxIsValid, LINE_KINDS, DEFAULT_BORDER_LEVEL, buildDivisionsQuery, deriveDivisionLevels } from "./overpass-lines.js";

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

// The board's admin-division hierarchy, so a border card can ask for "the 1st division"
// rather than for a hardcoded admin_level that does not exist everywhere (§5.6.1).
app.get("/overpass/divisions", async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
    return res.status(400).json({ error: "lat/lon must be numbers within ±90/±180." });
  }
  try {
    const json = await runOverpass(buildDivisionsQuery(lat, lon));
    res.json({ source: "overpass", levels: deriveDivisionLevels(json) });
  } catch (err) {
    if (err.fatal) {
      console.error("Overpass rejected the divisions query (query bug, not an outage):", err.message);
      return res.status(400).json({ error: "Overpass rejected the query.", detail: err.message });
    }
    console.error(`Overpass divisions failed after ${OVERPASS_PASSES} passes over ${OVERPASS_ENDPOINTS.length} endpoints:`, err.message);
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

// ---- Phase 13: Socket.IO multiplayer relay --------------------------------
// A RELAY, not a store (Circuit pattern): rooms keyed by a short session code, only
// ephemeral in-memory session state (last snapshot + membership) is kept. If the
// server restarts, clients recover by having the host re-offer a snapshot. Lives in
// this same Express app so there's one Node Web Service (also serves /overpass).
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: ALLOW_ORIGIN, methods: ["GET", "POST"] },
});

const sessions = new Map(); // code -> { hostDeviceId, members: Map<deviceId,{role}>, snapshot }

io.on("connection", (socket) => {
  let joinedCode = null;
  let myDeviceId = null;

  // Create or join a session room. First device to a code is the host (snapshot
  // authority). Ack returns the host id + the cached snapshot (null if first in).
  socket.on("session.join", ({ code, role, deviceId }, ack) => {
    if (!code || !deviceId) { ack?.({ ok: false, error: "code and deviceId required" }); return; }
    joinedCode = String(code).toUpperCase();
    myDeviceId = deviceId;
    socket.join(joinedCode);
    let s = sessions.get(joinedCode);
    if (!s) { s = { hostDeviceId: deviceId, members: new Map(), snapshot: null }; sessions.set(joinedCode, s); }
    s.members.set(deviceId, { role });
    ack?.({ ok: true, host: s.hostDeviceId, isHost: s.hostDeviceId === deviceId, snapshot: s.snapshot, members: [...s.members.keys()] });
    // Tell existing members someone joined (host re-offers a fresh snapshot on this).
    socket.to(joinedCode).emit("presence", { deviceId, role, joined: true, members: [...s.members.keys()] });
  });

  // Relay a game event to everyone else in the room; cache snapshots for late joiners.
  socket.on("event", ({ code, event }) => {
    const room = (code && String(code).toUpperCase()) || joinedCode;
    if (!room || !event) return;
    if (event.kind === "snapshot") {
      const s = sessions.get(room);
      if (s) s.snapshot = event.payload;
    }
    socket.to(room).emit("event", event);
  });

  socket.on("session.leave", () => cleanup());
  socket.on("disconnect", () => cleanup());

  function cleanup() {
    if (!joinedCode) return;
    const s = sessions.get(joinedCode);
    if (s) {
      s.members.delete(myDeviceId);
      socket.to(joinedCode).emit("presence", { deviceId: myDeviceId, joined: false, members: [...s.members.keys()] });
      if (s.members.size === 0) sessions.delete(joinedCode); // GC empty rooms
    }
    socket.leave(joinedCode);
    joinedCode = null;
  }
});

httpServer.listen(PORT, () => console.log(`JLTG backend listening on :${PORT} (Overpass proxy /overpass · multiplayer relay /socket.io)`));
