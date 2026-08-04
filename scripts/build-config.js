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
import { shortCommit } from "../src/build-info.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "config.js");
const VERSION_OUT = path.join(__dirname, "..", "version.json");

const key = process.env.GOOGLE_MAPS_API_KEY || "";
const mapId = process.env.MAP_ID || "";
const centerLat = process.env.DEFAULT_CENTER_LAT || "1.2830";
const centerLng = process.env.DEFAULT_CENTER_LNG || "103.8590";
const zoom = process.env.DEFAULT_ZOOM || "12";
const overpassProxy = process.env.OVERPASS_PROXY_URL || "";
const multiplayerUrl = process.env.MULTIPLAYER_URL || "";
// Phase 50 (req #6): Render sets RENDER_GIT_COMMIT on every build automatically
// (both Static Sites and Web Services) — no dashboard config needed. Falls back
// to "dev" for a local build (this script doesn't even run for local dev's own
// config.js, but keeps the helper honest for any other caller).
const buildId = shortCommit(process.env.RENDER_GIT_COMMIT) || "dev";
const fullCommit = (process.env.RENDER_GIT_COMMIT || "").trim();
const builtAt = new Date().toISOString();

if (!key) {
  console.warn(
    "[build-config] GOOGLE_MAPS_API_KEY is not set — writing a config with an empty key. " +
    "The app will fall back to its on-device key-entry screen. Set the env var in Render's " +
    "dashboard (or render.yaml) to bake the key in at build time."
  );
}

// v2: the same courtesy the Maps key gets. A build with no proxy produces an app that runs
// but quietly answers a weaker set of questions — no 🚄 Rail, no sourced coastline or
// borders, the Station's Line card refusing, and the peak / brand:wikidata cards falling back
// to a Google NAME search that matches "Mountain View Hotel" as readily as a summit.
//
// Only warned about on a real deploy: locally an empty proxy is the normal, expected state.
if (!overpassProxy && process.env.RENDER) {
  console.warn(
    "[build-config] OVERPASS_PROXY_URL is not set — this deploy will have NO OpenStreetMap " +
    "access. Rail geometry, sourced coastline/borders, the Station's Line card and the " +
    "exact peak/brand lookups will all be unavailable or degraded to Google's name search. " +
    "Set it to the backend service's URL (e.g. https://jltg-backend.onrender.com) in the " +
    "Render dashboard for the STATIC SITE."
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
  MULTIPLAYER_URL: ${JSON.stringify(multiplayerUrl)},
  BUILD_ID: ${JSON.stringify(buildId)},
  BUILT_AT: ${JSON.stringify(builtAt)},
};
`;

fs.writeFileSync(OUT, contents, "utf8");
console.log(`[build-config] wrote ${OUT} (key ${key ? "present" : "EMPTY"}, mapId ${mapId ? "present" : "empty"}, build ${buildId}).`);

// The same build id again, as a tiny JSON file the running app can re-fetch at any time.
//
// It has to be a SEPARATE file from config.js, and that is the entire trick. config.js is
// loaded once when the page loads, so its BUILD_ID is frozen at whatever served the page —
// which is exactly the value in question when a stale shell is suspected. version.json is
// fetched fresh, so comparing the two compares "the build I am made of" against "the build
// the origin has now". A single file could not tell those apart, because it would only ever
// report one of them. See src/version-check.js.
//
// It carries no secrets — a public commit id and a timestamp — so unlike config.js it is
// safe to serve to anyone, and it is written unconditionally (config.js above refuses to
// overwrite a local one; there is nothing here worth protecting).
const versionJson = JSON.stringify({
  commit: buildId,
  fullCommit: fullCommit || null,
  builtAt,
}, null, 2) + "\n";

fs.writeFileSync(VERSION_OUT, versionJson, "utf8");
console.log(`[build-config] wrote ${VERSION_OUT} (commit ${buildId}).`);
