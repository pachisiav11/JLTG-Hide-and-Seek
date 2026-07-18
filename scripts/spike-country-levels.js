#!/usr/bin/env node
// Spike 2: which SINGLE admin_level can serve as a country's Nth division EVERYWHERE in it?
//
// Spike 1 (spike-admin-levels.js) probed city centres and derived an ordinal per board. That
// is the wrong question for a Matching card. A Matching card asks "are we in the same 2nd
// division?", and both players must be comparing the SAME KIND of boundary — a seeker on
// Tokyo wards (L7) and a hider on Hokkaido subprefectures (L5) are not answering one
// question. Japan's official season used subprefectures throughout for exactly this reason,
// accepting a near-unusable card over an inconsistent one.
//
// So the unit of measurement here is COVERAGE: across points spread over the whole country,
// what fraction have a boundary at level L? A level is usable as a division only at 100%.
//
// City centres cannot answer this. Japanese cities (市) are not inside districts (郡), so a
// city-only sample systematically misses tiers that rural points have. Hence a grid.
//
//   node scripts/spike-country-levels.js            # fetch missing probes, then stop
//   node scripts/spike-country-levels.js --report   # analyse from cache, no network
//
// Same running format as spike 1: one JSON cache, resume from it, retry in-script.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const ENDPOINTS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const CACHE = process.env.SPIKE_CACHE
  || "C:/Users/vihaa/AppData/Local/Temp/claude/D--Projects-JLTG/084d3442-183b-4134-9f9c-8d7931fa8a63/scratchpad/country-levels-cache.json";

const FETCH_TIMEOUT_MS = 90_000;
const MAX_ROUNDS = 10;
const PAUSE_MS = 900;
const PAUSE_ROUND_MS = 15_000;

// Grid resolution per country bbox. 5x5 = 25 candidate points; ocean/neighbour points are
// identified by their level-2 name and excluded from coverage rather than counted as gaps.
const GRID = 5;

// [name, S, W, N, E, level-2 names OSM may return]. A flat list, so a duplicate or stray
// key cannot silently drop a country the way an object literal would.
const COUNTRY_BOXES = [
  ["India",       8.0, 68.5, 35.0, 89.0,      ["India"]],
  ["USA",         25.5, -124.0, 48.5, -67.0,  ["United States", "United States of America"]],
  ["Canada",      43.0, -132.0, 60.0, -55.0,  ["Canada"]],
  ["Singapore",   1.24, 103.62, 1.46, 104.02, ["Singapore"]],
  ["Japan",       31.0, 130.0, 45.3, 145.5,   ["Japan"]],
  ["Vietnam",     8.7, 102.3, 23.2, 109.3,    ["Vietnam", "Việt Nam"]],
  ["Thailand",    6.0, 97.5, 20.3, 105.5,     ["Thailand"]],
  ["UK",          50.0, -7.5, 58.6, 1.7,      ["United Kingdom"]],
  ["Switzerland", 45.9, 6.0, 47.7, 10.4,      ["Switzerland"]],
  ["Germany",     47.4, 6.0, 54.8, 14.9,      ["Germany", "Deutschland"]],
  ["France",      42.5, -4.5, 51.0, 8.0,      ["France"]],
  ["Spain",       36.1, -9.2, 43.7, 3.3,      ["Spain", "España"]],
  ["Italy",       36.7, 6.7, 47.0, 18.5,      ["Italy", "Italia"]],
  ["Netherlands", 50.8, 3.4, 53.5, 7.2,       ["Netherlands", "Nederland"]],
  ["Poland",      49.1, 14.2, 54.8, 24.1,     ["Poland", "Polska"]],
  ["Austria",     46.4, 9.6, 49.0, 17.1,      ["Austria", "Österreich"]],
  ["Czechia",     48.6, 12.1, 51.0, 18.8,     ["Czechia", "Česko"]],
  ["Hungary",     45.8, 16.2, 48.5, 22.8,     ["Hungary", "Magyarország"]],
  ["Belgium",     49.5, 2.6, 51.5, 6.3,       ["Belgium", "België / Belgique / Belgien"]],
  ["Portugal",    37.0, -9.4, 42.1, -6.3,     ["Portugal"]],
  ["Greece",      35.0, 20.1, 41.7, 26.5,     ["Greece", "Ελλάδα"]],
  ["Sweden",      55.4, 11.2, 68.5, 24.0,     ["Sweden", "Sverige"]],
  ["Denmark",     54.6, 8.1, 57.7, 12.6,      ["Denmark", "Danmark"]],
  ["Norway",      58.0, 5.0, 70.5, 30.5,      ["Norway", "Norge"]],
  ["Finland",     60.0, 21.5, 69.8, 31.0,     ["Finland", "Suomi"]],
  ["Ireland",     51.5, -10.4, 55.3, -6.1,    ["Ireland", "Éire / Ireland"]],
  ["Australia",   -43.5, 114.0, -11.0, 153.5, ["Australia"]],
  ["New Zealand", -46.6, 166.5, -34.5, 178.5, ["New Zealand", "New Zealand / Aotearoa"]],
  ["South Korea", 34.0, 126.2, 38.4, 129.4,   ["South Korea", "대한민국"]],
  ["China",       21.0, 76.0, 49.0, 130.0,    ["China", "中国"]],
  ["Hong Kong",   22.19, 113.83, 22.55, 114.4,["Hong Kong", "香港 Hong Kong"]],
  ["Taiwan",      21.9, 120.0, 25.3, 122.0,   ["Taiwan", "臺灣"]],
  ["Malaysia",    1.0, 99.6, 6.9, 119.3,      ["Malaysia"]],
  ["Indonesia",   -10.5, 95.0, 5.9, 141.0,    ["Indonesia"]],
  ["Philippines", 5.5, 117.2, 18.6, 126.6,    ["Philippines"]],
  ["UAE",         22.6, 51.5, 26.1, 56.4,     ["United Arab Emirates"]],
  ["Turkey",      36.0, 26.0, 42.1, 44.8,     ["Turkey", "Türkiye"]],
  ["Brazil",      -33.7, -73.9, 5.2, -34.8,   ["Brazil", "Brasil"]],
  ["Mexico",      14.5, -117.1, 32.7, -86.7,  ["Mexico", "México"]],
  ["Argentina",   -55.0, -73.5, -21.8, -53.6, ["Argentina"]],
  ["South Africa",-34.8, 16.5, -22.1, 32.9,   ["South Africa"]],
  ["Egypt",       22.0, 25.0, 31.6, 35.8,     ["Egypt", "مصر"]],
  ["Israel",      29.5, 34.3, 33.3, 35.9,     ["Israel", "ישראל"]],
  ["Russia",      44.0, 30.0, 68.0, 160.0,    ["Russia", "Россия"]],
];

// Grid points, nudged off exact round coordinates. A point landing precisely on a boundary
// is ambiguous in `is_in` (it can return both neighbours or neither), and round numbers are
// disproportionately likely to BE a boundary — many are drawn on parallels and meridians.
function gridPoints(s, w, n, e) {
  const pts = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const lat = s + ((n - s) * (i + 0.5)) / GRID + (n - s) * 0.013;
      const lon = w + ((e - w) * (j + 0.5)) / GRID + (e - w) * 0.017;
      pts.push([Number(lat.toFixed(4)), Number(lon.toFixed(4))]);
    }
  }
  return pts;
}

const PROBES = [];
for (const [country, s, w, n, e, names] of COUNTRY_BOXES) {
  gridPoints(s, w, n, e).forEach(([lat, lon], i) => {
    PROBES.push({ country, name: `grid-${i}`, lat, lon, expect: names });
  });
}

const key = (p) => `${p.country}|${p.name}`;
const query = (p) => `[out:json][timeout:90];
is_in(${p.lat},${p.lon})->.a;
area.a["boundary"="administrative"];
out tags;`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(endpoint, p) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      body: "data=" + encodeURIComponent(query(p)),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: ctl.signal,
    });
    const text = await resp.text();
    if (resp.status === 400) throw Object.assign(new Error(`HTTP 400 (fatal)`), { fatal: true });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (!text.trimStart().startsWith("{")) throw new Error("non-JSON body (endpoint busy)");
    const json = JSON.parse(text);
    if (!Array.isArray(json.elements)) throw new Error("no elements array");
    return json.elements
      .map((el) => ({ level: Number(el.tags?.admin_level), name: el.tags?.["name:en"] || el.tags?.name || null }))
      .filter((a) => Number.isFinite(a.level));
  } finally { clearTimeout(timer); }
}

async function fetchProbe(p) {
  let lastErr;
  for (const ep of ENDPOINTS) {
    try { return { ok: true, areas: await fetchOnce(ep, p) }; }
    catch (err) { lastErr = err; if (err.fatal) return { ok: false, error: err.message, fatal: true }; }
  }
  return { ok: false, error: String(lastErr?.message || lastErr) };
}

const loadCache = () => (existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {});
const saveCache = (c) => { mkdirSync(dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify(c)); };

async function run() {
  const cache = loadCache();
  let out = PROBES.filter((p) => !cache[key(p)]?.ok && !cache[key(p)]?.fatal);
  console.error(`${PROBES.length} probes; ${PROBES.length - out.length} cached; ${out.length} outstanding.`);
  for (let round = 1; round <= MAX_ROUNDS && out.length; round++) {
    let got = 0;
    for (const p of out) {
      const res = await fetchProbe(p);
      cache[key(p)] = { ...res, country: p.country, name: p.name, lat: p.lat, lon: p.lon, expect: p.expect };
      saveCache(cache);
      if (res.ok) got++;
      await sleep(PAUSE_MS);
    }
    out = out.filter((p) => !cache[key(p)]?.ok && !cache[key(p)]?.fatal);
    console.error(`round ${round}: +${got}, ${out.length} outstanding`);
    if (out.length) await sleep(PAUSE_ROUND_MS);
  }
  console.error(`DONE: ${PROBES.filter((p) => cache[key(p)]?.ok).length}/${PROBES.length}. Cache: ${CACHE}`);
}

// ---------------------------------------------------------------------------
// Report: per-country level coverage
// ---------------------------------------------------------------------------
function report() {
  const cache = loadCache();
  const byCountry = new Map();
  let seaDropped = 0;
  for (const r of Object.values(cache)) {
    if (!r.ok) continue;
    // A grid point can land in the sea or in a neighbour. Neither is a gap in THIS country's
    // coverage, so both are excluded rather than counted as a missing boundary.
    const country2 = r.areas.find((a) => a.level === 2)?.name;
    if (!country2 || !r.expect.includes(country2)) continue;
    // A point can also sit in TERRITORIAL WATERS: inside the country's level-2 polygon (which
    // commonly extends over the sea) but with no land division at all. Checked directly: the
    // 3 points below are San Diego's coastal water, the Mediterranean off Nice, and the North
    // Sea off Belgium — real land at those bboxes has a level-4 area, these points don't
    // because there IS no land there. Counting them as a level-4 "miss" isn't measuring
    // coverage, it's measuring how much of the bbox is ocean. Excluded from every level's
    // denominator, not just level 4's, since the same water point is not-a-gap for ANY level.
    if (!r.areas.some((a) => a.level > 3)) { seaDropped++; continue; }
    if (!byCountry.has(r.country)) byCountry.set(r.country, []);
    byCountry.get(r.country).push(r);
  }
  console.log(`(${seaDropped} grid points excluded as sea/territorial-water — no land division at all)\n`);

  console.log(`# Country-wide level coverage — grid sample\n`);
  console.log(`A level is usable as a country's Nth division only at **100% coverage**: below`);
  console.log(`that, some of the country has no such boundary and the card breaks there.\n`);
  console.log(`| Country | in-country pts | full-coverage levels | 1st | 2nd | 3rd | partial (level:%) |`);
  console.log(`|---|---|---|---|---|---|---|`);

  const table = {};
  for (const [country, list] of [...byCountry].sort()) {
    const counts = new Map();
    for (const r of list) {
      for (const lvl of new Set(r.areas.map((a) => a.level))) {
        if (lvl <= 3) continue; // country + macro-region, per §5.6.1 step 2
        counts.set(lvl, (counts.get(lvl) || 0) + 1);
      }
    }
    const n = list.length;
    const full = [...counts].filter(([, c]) => c === n).map(([l]) => l).sort((a, b) => a - b);
    const partial = [...counts].filter(([, c]) => c < n).sort((a, b) => a[0] - b[0])
      .map(([l, c]) => `${l}:${Math.round((c / n) * 100)}%`);
    table[country] = full;
    console.log(`| ${country} | ${n} | ${full.join(", ") || "—"} | ${full[0] ?? "—"} | ${full[1] ?? "—"} | ${full[2] ?? "—"} | ${partial.join(" ") || "—"} |`);
  }

  console.log(`\n## Proposed table (levels with 100% coverage, in order)\n`);
  console.log("```js");
  for (const [c, full] of Object.entries(table).sort()) {
    console.log(`  ${JSON.stringify(c)}: [${full.join(", ")}],`);
  }
  console.log("```");
}

if (process.argv.includes("--report")) report();
else await run();
