#!/usr/bin/env node
// Build-time config generator for hosted deploys (Phase 8 — Render).
//
// On Render (Static Site) the Maps API key is injected as an ENVIRONMENT VARIABLE
// (dashboard or render.yaml) instead of a checked-out file, so there's no manual
// "copy config.example.js → config.js" step per deploy. This script reads those env
// vars at build time and writes `config.js` (the same git-ignored file the app
// already loads via <script src="config.js">).
//
// Local dev is UNCHANGED: keep using your own git-ignored config.js and never run
// this script — it only runs in Render's build step. It refuses to overwrite an
// existing config.js unless FORCE_CONFIG=1, so a stray local run can't clobber your
// local key.
//
// NOTE: this does NOT hide the key from the browser — a Maps JS key is a
// client-side value either way, and it MUST still be restricted in Google Cloud by
// HTTP referrer (your *.onrender.com subdomain) + the enabled APIs. See README.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "config.js");

const key = process.env.GOOGLE_MAPS_API_KEY || "";
const mapId = process.env.MAP_ID || "";
const centerLat = process.env.DEFAULT_CENTER_LAT || "1.2830";
const centerLng = process.env.DEFAULT_CENTER_LNG || "103.8590";
const zoom = process.env.DEFAULT_ZOOM || "12";
const overpassProxy = process.env.OVERPASS_PROXY_URL || "";

if (!key) {
  console.warn(
    "[build-config] GOOGLE_MAPS_API_KEY is not set — writing a config with an empty key. " +
    "The app will fall back to its on-device key-entry screen. Set the env var in Render's " +
    "dashboard (or render.yaml) to bake the key in at build time."
  );
}

if (fs.existsSync(OUT) && process.env.FORCE_CONFIG !== "1" && !process.env.RENDER) {
  console.error(
    "[build-config] config.js already exists and neither RENDER nor FORCE_CONFIG=1 is set. " +
    "Refusing to overwrite your local config.js. (This is expected on your dev machine.)"
  );
  process.exit(0);
}

const contents = `// GENERATED at build time by scripts/build-config.js — do not edit by hand.
// The Maps JS key is a client-side value (visible in the browser); it must stay
// restricted in Google Cloud by HTTP referrer + enabled APIs.
window.JLTG_CONFIG = {
  GOOGLE_MAPS_API_KEY: ${JSON.stringify(key)},
  MAP_ID: ${JSON.stringify(mapId)},
  DEFAULT_CENTER: { lat: ${Number(centerLat)}, lng: ${Number(centerLng)} },
  DEFAULT_ZOOM: ${Number(zoom)},
  OVERPASS_PROXY_URL: ${JSON.stringify(overpassProxy)},
};
`;

fs.writeFileSync(OUT, contents, "utf8");
console.log(`[build-config] wrote ${OUT} (key ${key ? "present" : "EMPTY"}, mapId ${mapId ? "present" : "empty"}).`);
