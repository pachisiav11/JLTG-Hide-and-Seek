#!/usr/bin/env node
// Reads the spike-admin-levels cache and answers the two questions the spike exists for:
//
//   1. Is the Nth admin division a FIXED admin_level within a country? (per-country table)
//   2. If not, does deriving it from the BOARD instead hold up everywhere?
//
// Emits a markdown report on stdout. Pure analysis — no network.

import { readFileSync } from "node:fs";

const CACHE = process.env.SPIKE_CACHE
  || "C:/Users/vihaa/AppData/Local/Temp/claude/D--Projects-JLTG/084d3442-183b-4134-9f9c-8d7931fa8a63/scratchpad/admin-levels-cache.json";

const rows = Object.values(JSON.parse(readFileSync(CACHE, "utf8"))).filter((r) => r.ok);

// GUIDE.md §5.6.1 steps 2-3: drop level 2 (country) and level 3 (macro-regions that are
// not administrative -- Brazil's "North Region", France's "Metropolitan France", and the
// Netherlands' level 3 which is the country's own name repeated).
const divisionLevels = (r) =>
  [...new Set(r.areas.map((a) => a.level).filter((l) => l > 3))].sort((a, b) => a - b);

const nameAt = (r, level) => r.areas.find((a) => a.level === level)?.name ?? "—";

const byCountry = new Map();
for (const r of rows) {
  if (!byCountry.has(r.country)) byCountry.set(r.country, []);
  byCountry.get(r.country).push(r);
}

// --- Q1: is the ordinal→level mapping fixed within each country? -----------
let stable = 0, unstable = 0;
const unstableDetail = [];
const out = [];

out.push("| Country | 1st div level(s) | 2nd div level(s) | consistent? | dissenting cities |");
out.push("|---|---|---|---|---|");

for (const [country, list] of [...byCountry].sort()) {
  const firsts = new Map(), seconds = new Map();
  for (const r of list) {
    const d = divisionLevels(r);
    const tally = (m, k) => { if (k == null) return; if (!m.has(k)) m.set(k, []); m.get(k).push(r.name); };
    tally(firsts, d[0]); tally(seconds, d[1]);
  }
  const fmt = (m) => [...m.keys()].sort((a, b) => a - b).join(" / ") || "—";
  // The majority level is the one a per-country table would have to pick; anything else
  // is a city that table would silently get wrong.
  const majority = (m) => [...m].sort((a, b) => b[1].length - a[1].length)[0];
  const sMaj = majority(seconds);
  const dissent = sMaj ? [...seconds].filter(([k]) => k !== sMaj[0]).flatMap(([k, v]) => v.map((n) => `${n}=${k}`)) : [];
  const ok = seconds.size <= 1 && firsts.size <= 1;
  if (ok) stable++; else { unstable++; unstableDetail.push([country, dissent]); }
  out.push(`| ${country} | ${fmt(firsts)} | ${fmt(seconds)} | ${ok ? "yes" : "**NO**"} | ${dissent.join(", ") || "—"} |`);
}

console.log(`# Admin-division spike — ${rows.length} probes, ${byCountry.size} countries\n`);
console.log(`## Q1. Can a per-country level table work?\n`);
console.log(`**${stable} of ${byCountry.size} countries are internally consistent; ${unstable} are not.**\n`);
console.log(out.join("\n"));

// --- Q2: does level 4 hold as the 1st division? ----------------------------
console.log(`\n## Q2. Is level 4 always the 1st division?\n`);
const no4 = rows.filter((r) => !divisionLevels(r).includes(4));
if (!no4.length) console.log("Level 4 present in every probe.");
else {
  console.log(`**Level 4 is ABSENT in ${no4.length} probes** — a hardcoded level-4 query returns nothing there:\n`);
  console.log("| Country | Probe | levels present | 1st division actually is |");
  console.log("|---|---|---|---|");
  for (const r of no4) {
    const d = divisionLevels(r);
    console.log(`| ${r.country} | ${r.name} | ${d.join(",")} | ${d[0]} (${nameAt(r, d[0])}) |`);
  }
}

// --- Q3: what the level-4 area is actually named, where it exists ----------
console.log(`\n## Q3. Level-4 names (spot-check that level 4 is a real 1st division)\n`);
for (const [country, list] of [...byCountry].sort()) {
  const names = [...new Set(list.map((r) => nameAt(r, 4)).filter((n) => n !== "—"))];
  console.log(`- **${country}**: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` … (${names.length})` : ""}`);
}
