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
//
// Merges THIS grid cache with the city-centre cache from spike-admin-levels.js (if present).
// Both are needed. The grid catches rural tiers a city sample misses; the city probes catch
// the CITY-STATES a coarse grid flies over — Berlin, Washington DC, Brussels, Kuala Lumpur —
// which are exactly the points that (correctly) demote a country's 2nd division. Run
// `spike-admin-levels.js` first for the full picture; the grid alone over-credits countries
// like the USA with a universal county level it never tested against DC.
// ---------------------------------------------------------------------------

// A level-2 area OSM returns for a point that is really at sea. Must be stripped before
// picking the country, or a coastal point resolves to "Taiwan maritime boundary" et al.
const MARITIME_NAME = /coastal water|territorial|maritime|Küstengewässer|Festlandsockel|continental shelf|Strofades|exclusive economic|\bEEZ\b/i;
// SARs that sit under another country's level-2 boundary but run their own divisions.
const SAR_NAMES = new Set(["Hong Kong", "Macau", "Macao"]);

const CITY_CACHE = process.env.CITY_CACHE
  || CACHE.replace("country-levels-cache.json", "admin-levels-cache.json");

function report() {
  const grid = Object.values(loadCache());
  const city = existsSync(CITY_CACHE) ? Object.values(JSON.parse(readFileSync(CITY_CACHE, "utf8"))) : [];
  // `expect` (the accepted level-2 names) is defined on grid records; carry it to city
  // records of the same country label, which don't store one.
  const expectByCountry = new Map();
  for (const r of grid) if (r.expect && !expectByCountry.has(r.country)) expectByCountry.set(r.country, r.expect);
  const expectOf = (r) => r.expect || expectByCountry.get(r.country) || [r.country];

  // Strip maritime areas up front; everything downstream reasons about land areas only.
  const all = [...grid, ...city].filter((r) => r.ok)
    .map((r) => ({ ...r, land: r.areas.filter((a) => !MARITIME_NAME.test(a.name || "")) }));
  const isGrid = (r) => /^grid-\d+$/.test(r.name || "");
  const keyOf = (r) => {
    const sar = r.land.find((a) => SAR_NAMES.has(a.name));
    if (sar) return sar.name;
    const c2 = r.land.filter((a) => a.level === 2);
    const good = c2.find((a) => expectOf(r).includes(a.name));
    return good ? good.name : c2[0]?.name;
  };

  // Which surveyed countries claim each level-4 name — to catch border-straddle points whose
  // only province belongs to a neighbour (a German-labelled point sitting in Dutch Drenthe).
  const provCountry = new Map();
  for (const r of all) {
    if (!expectOf(r).includes(keyOf(r))) continue;
    for (const a of r.land) if (a.level === 4 && a.name) (provCountry.get(a.name) || provCountry.set(a.name, new Set()).get(a.name)).add(r.country);
  }

  let dropped = 0;
  const byCountry = new Map();
  for (const r of all) {
    const cn = keyOf(r);
    if (!cn) { dropped++; continue; }
    // SAR points are grouped by their own name; ordinary points must match their country.
    const country = SAR_NAMES.has(cn) ? cn : r.country;
    if (!SAR_NAMES.has(cn) && !expectOf(r).includes(cn)) { dropped++; continue; }
    const max = Math.max(0, ...r.land.map((a) => a.level));
    // A blind grid point is trustworthy as "inhabited land needing full coverage" only if it
    // actually hit something finer than a province (≥5) — otherwise it is over territorial
    // water where a coastal province extends to sea. A city probe is inhabited by definition,
    // so it counts with just a level-4 area (Egypt tags no finer tier anywhere on land).
    if (isGrid(r) ? max < 5 : max < 4) { dropped++; continue; }
    const l4 = r.land.filter((a) => a.level === 4).map((a) => a.name);
    if (l4.length && l4.every((n) => { const s = provCountry.get(n); return s && !s.has(r.country); })) { dropped++; continue; }
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country).push(r);
  }
  console.log(`(${dropped} probes dropped as sea / territorial-water / wrong-country / border-straddle)\n`);
  console.log(`# Country-wide level coverage — grid + city merge\n`);
  console.log(`A level is usable as a country's Nth division only at **100% coverage**: below`);
  console.log(`that, some inhabited part of the country has no such boundary and the card breaks there.\n`);
  console.log(`| Country | pts | full-coverage levels | 1st | 2nd | near-miss (level:%) |`);
  console.log(`|---|---|---|---|---|---|`);

  const table = {};
  for (const [country, list] of [...byCountry].sort()) {
    // For a SAR the territory itself is tagged level 3–4 (Hong Kong is both), so its divisions
    // start at level 5 — dropping ≤4 is the SAR analogue of dropping ≤3 for a normal country.
    const floor = SAR_NAMES.has(country) ? 4 : 3;
    const counts = new Map();
    for (const r of list) for (const lvl of new Set(r.land.map((a) => a.level))) {
      if (lvl <= floor) continue; // country/territory + macro-region
      counts.set(lvl, (counts.get(lvl) || 0) + 1);
    }
    const n = list.length;
    const full = [...counts].filter(([, c]) => c === n).map(([l]) => l).sort((a, b) => a - b);
    const near = [...counts].filter(([, c]) => c < n && c / n >= 0.85).sort((a, b) => a[0] - b[0])
      .map(([l, c]) => `${l}:${Math.round((c / n) * 100)}%`);
    table[country] = full.slice(0, 2); // the game uses only 1st + 2nd division
    console.log(`| ${country} | ${n} | ${full.join(", ") || "—"} | ${full[0] ?? "—"} | ${full[1] ?? "—"} | ${near.join(" ") || "—"} |`);
  }

  console.log(`\n## Proposed table (first two full-coverage levels per country)\n`);
  console.log("```js");
  for (const [c, full] of Object.entries(table).sort()) console.log(`  ${JSON.stringify(c)}: [${full.join(", ")}],`);
  console.log("```");
}

if (process.argv.includes("--report")) report();
else await run();
