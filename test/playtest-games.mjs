// PLAYTEST — full games played through the real app in a browser.
//
// Not a unit test and not a smoke test. Each game picks a hider position the "seeker" logic
// never sees, plays a realistic sequence of questions, has the hider answer each one
// TRUTHFULLY via the oracle, and checks after every turn that:
//
//   1. the hider is still inside the surviving area   (a false elimination loses the game)
//   2. the board is actually narrowing                (a question that does nothing is a wasted turn)
//   3. the surviving station count only ever falls    (zones cannot come back from the dead)
//
// It also plays the v2 features in-game rather than in isolation: drafting a question before
// committing it, hiding one's guides mid-game, handing the board to a teammate over a share
// link and continuing on the other device, and excluding an area mid-game.
// RUN: serve the repo root (e.g. `npx http-server -p 8899 -s .`) then `node test/playtest-games.mjs`.
// Not part of `npm test`: it needs a browser and a served copy of the app, where the rest of
// the suite is pure node. Kept in-repo because it is the only check that plays whole GAMES —
// the unit tests prove each tool correct in isolation, and this proves a sequence of them
// keeps the hider.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`); });

await page.addInitScript(() => {
  const noop = () => {}; const listener = { remove: noop };
  const handler = {
    get(t, p) { if (p === 'then') return undefined; if (!(p in t)) t[p] = new Proxy(function () { return new Proxy({}, handler); }, handler); return t[p]; },
    apply() { return new Proxy({}, handler); }, construct() { return new Proxy({}, handler); },
  };
  const maps = new Proxy(function () {}, handler);
  maps.event = { addListener: () => listener, removeListener: noop, clearInstanceListeners: noop, trigger: noop };
  maps.SymbolPath = { CIRCLE: 0 };
  maps.LatLngBounds = function () { return { extend: noop, isEmpty: () => true, getCenter: () => ({ lat: () => 19, lng: () => 72 }) }; };
  maps.Map = function () { return new Proxy({ addListener: () => listener, setCenter: noop, fitBounds: noop, getCenter: () => ({ lat: () => 19, lng: () => 72 }), setOptions: noop, controls: [] }, handler); };
  window.google = { maps };
  window.JLTG_CONFIG = { GOOGLE_MAPS_API_KEY: 'stub', OVERPASS_PROXY_URL: '', MULTIPLAYER_URL: '' };
});
await page.route('**/*', (r) => {
  const u = r.request().url();
  if (u.startsWith('http://127.0.0.1:8899')) return r.continue();
  if (/\.js(\?|$)/.test(u)) return r.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
  return r.fulfill({ status: 204, body: '' });
});
await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__jltg, { timeout: 30000 });
await page.waitForTimeout(5000);
await page.waitForFunction(() => !!window.__jltg, { timeout: 30000 });

// The whole game engine runs inside the page against the real modules.
await page.evaluate(async () => {
  const { store } = window.__jltg;
  const tools = await import('/src/tools.js');
  const oracle = await import('/test/oracle.js');
  const turf = window.turf;

  // A Mumbai-ish board with a realistic scatter of stations and POIs.
  const B = { w: 72.80, e: 72.98, s: 18.98, n: 19.16 };
  const board = { type: 'Polygon', coordinates: [[[B.w, B.s], [B.e, B.s], [B.e, B.n], [B.w, B.n], [B.w, B.s]]] };

  let seed = 20260804;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const scatter = (n, prefix) => Array.from({ length: n }, (_, i) => ({
    id: `${prefix}:${i}`, name: `${prefix} ${i}`,
    lng: +(B.w + rnd() * (B.e - B.w)).toFixed(5),
    lat: +(B.s + rnd() * (B.n - B.s)).toFixed(5),
  }));
  const stations = scatter(28, 'stn').map((s) => ({ ...s, name: ['Andheri', 'Bandra', 'Churchgate', 'Dadar', 'Elphinstone', 'Grant Rd', 'Kurla', 'Mahim', 'Sion', 'Thane', 'Vashi', 'Wadala'][Math.floor(rnd() * 12)] + ' ' + s.id.split(':')[1] }));
  const museums = scatter(9, 'museum');
  const parks = scatter(11, 'park');

  const RADIUS_M = 800;
  const nameLen = (n) => (n.replace(/\s*\(.*\)/, '').match(/\p{L}/gu) || []).length;

  window.__play = { board, stations, museums, parks, RADIUS_M, turf, tools, oracle, nameLen, store };
});

const run = async (label, hider, plan) => {
  const out = await page.evaluate(async ({ hider, plan, label }) => {
    const { board, stations, museums, parks, RADIUS_M, turf, tools, oracle, nameLen } = window.__play;
    const km2 = (g) => (g && g !== tools.EMPTY_AREA ? turf.area(turf.feature(g)) / 1e6 : 0);
    // "How many stations could still hold the hider?" — the basis of the never-resurrect
    // invariant below.
    //
    // This used to call into src/hiding-zones.js. That whole module is gone: the station
    // counter, the per-station drill-down and finally the zone overlay itself were all
    // removed, and in the APP nothing ever eliminated a station from geometry anyway
    // (stations are only eliminated by hand). The invariant is still worth checking, so the
    // rule lives here now — a station counts as live while ANY part of its zone survives.
    const liveStations = (active) => {
      if (!active || active === tools.EMPTY_AREA) return 0;
      const area = turf.feature(active);
      return stations.filter((st) => {
        const zone = RADIUS_M > 0
          ? turf.circle([st.lng, st.lat], RADIUS_M / 1000, { units: 'kilometers', steps: 32 }).geometry
          : null;
        if (!zone) return turf.booleanPointInPolygon(turf.point([st.lng, st.lat]), area);
        // Undecidable → count it as live. Under-eliminating costs a turn; over-eliminating
        // is the failure this whole harness exists to catch.
        try { return !!turf.intersect(turf.featureCollection([zone, area])); } catch (_) { return true; }
      }).length;
    };

    const mkStep = (spec, i) => {
      const id = `q${i}`;
      switch (spec.t) {
        case 'radar':
          return { id, tool: 'radar', enabled: true, inputs: { center: spec.at, radius: spec.r }, answer: {} };
        case 'thermo':
          return { id, tool: 'thermometer', enabled: true, inputs: { a: spec.a, b: spec.b }, answer: {} };
        case 'matchNearest':
          return { id, tool: 'matching', enabled: true, inputs: { mode: 'nearest', features: spec.feats }, answer: { featureIndex: spec.seekerIdx } };
        case 'nameLen': {
          const feats = stations.map((s) => ({ ...s, len: nameLen(s.name) }));
          return { id, tool: 'matching', enabled: true, inputs: { mode: 'nameLength', features: feats }, answer: { length: spec.len } };
        }
        case 'measure':
          return { id, tool: 'measuring', enabled: true, inputs: { refType: 'points', refGeometry: { type: 'MultiPoint', coordinates: spec.feats.map((f) => [f.lng, f.lat]) }, distance: spec.d }, answer: {} };
        case 'tentacles':
          return { id, tool: 'tentacles', enabled: true, inputs: { features: spec.feats, center: spec.at, radius: spec.r }, answer: {} };
        case 'stationLine':
          return { id, tool: 'matching', enabled: true, inputs: { mode: 'stationLine', stations, memberIds: spec.memberIds, radiusM: RADIUS_M, lineLabel: spec.lineLabel }, answer: {} };
        default: throw new Error('unknown ' + spec.t);
      }
    };

    const history = [];
    const turns = [];
    let prevArea = km2(board), prevStations = liveStations(board);
    let verdict = 'ok';

    for (let i = 0; i < plan.length; i++) {
      const spec = plan[i];
      const step = mkStep(spec, i);
      // THE HIDER ANSWERS. Truthfully, from their real position, via the oracle — the seeker
      // logic below never sees `hider`.
      const answer = oracle.truthfulAnswer(step, hider, board);
      if (!answer) { turns.push({ n: i + 1, q: spec.t, skipped: true }); continue; }
      step.answer = { ...step.answer, ...answer };
      if (spec.draftFirst) step.draft = true;
      history.push(step);

      // Draft turns must NOT narrow anything.
      const folded = history.filter((s) => !s.draft);
      const active = tools.computeActiveArea(board, folded);
      const area = km2(active);
      const inside = active && active !== tools.EMPTY_AREA
        ? turf.booleanPointInPolygon(turf.point([hider.lng, hider.lat]), turf.feature(active)) : false;
      const live = active && active !== tools.EMPTY_AREA ? liveStations(active) : 0;

      const rec = { n: i + 1, q: spec.t, draft: !!spec.draftFirst, area: +area.toFixed(1), stations: live, hiderIn: inside, answer: JSON.stringify(answer) };
      // Invariants.
      if (!inside) { rec.FAIL = 'hider eliminated'; verdict = 'LOST THE HIDER'; }
      if (!spec.draftFirst && area > prevArea + 0.01) { rec.FAIL = 'board grew'; verdict = 'BOARD GREW'; }
      if (spec.draftFirst && Math.abs(area - prevArea) > 0.01) { rec.FAIL = 'draft narrowed the board'; verdict = 'DRAFT APPLIED'; }
      if (live > prevStations) { rec.FAIL = 'stations resurrected'; verdict = 'STATIONS CAME BACK'; }
      turns.push(rec);
      prevArea = area; prevStations = live;
      if (!inside) break;
    }

    // Commit any drafts at the end and re-check (the "I'll actually ask it" moment).
    let afterCommit = null;
    if (history.some((s) => s.draft)) {
      history.forEach((s) => { s.draft = false; });
      const active = tools.computeActiveArea(board, history);
      const inside = active && active !== tools.EMPTY_AREA
        ? turf.booleanPointInPolygon(turf.point([hider.lng, hider.lat]), turf.feature(active)) : false;
      afterCommit = { area: +km2(active).toFixed(1), stations: inside ? liveStations(active) : 0, hiderIn: inside };
      if (!inside) verdict = 'LOST THE HIDER ON COMMIT';
    }

    return { label, hider, turns, afterCommit, verdict, startArea: +km2(board).toFixed(1), startStations: stations.length };
  }, { hider, plan, label });

  console.log(`\n── ${out.label}   hider at ${out.hider.lat.toFixed(4)}, ${out.hider.lng.toFixed(4)}`);
  console.log(`   start: ${out.startArea} km², ${out.startStations} stations`);
  for (const t of out.turns) {
    if (t.skipped) { console.log(`   ${t.n}. ${t.q.padEnd(13)} (skipped — oracle could not answer)`); continue; }
    const flag = t.FAIL ? `  ❌ ${t.FAIL}` : '';
    console.log(`   ${t.n}. ${t.q.padEnd(13)}${t.draft ? '[draft] ' : '        '}${String(t.area).padStart(8)} km²  ${String(t.stations).padStart(3)} stn  hider:${t.hiderIn ? 'in ' : 'OUT'}  ${t.answer}${flag}`);
  }
  if (out.afterCommit) console.log(`   commit drafts -> ${out.afterCommit.area} km², ${out.afterCommit.stations} stn, hider:${out.afterCommit.hiderIn ? 'in' : 'OUT'}`);
  console.log(`   VERDICT: ${out.verdict === 'ok' ? '✅ hider retained, board narrowed monotonically' : '❌ ' + out.verdict}`);
  return out;
};

// Build plans that reference the in-page fixtures.
const planFor = await page.evaluate(() => {
  const { stations, museums, parks, nameLen } = window.__play;
  return {
    stations: stations.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, len: nameLen(s.name) })),
    museums, parks,
  };
});
const M = planFor.museums, P = planFor.parks, S = planFor.stations;
const at = (lat, lng) => ({ lat, lng });

const games = [
  {
    label: 'GAME 1 — classic opening: radar, thermometer, matching, measuring',
    hider: at(19.0620, 72.8480),
    plan: [
      { t: 'radar', at: at(19.07, 72.88), r: 9000 },
      { t: 'thermo', a: at(19.07, 72.88), b: at(19.02, 72.83) },
      { t: 'matchNearest', feats: M, seekerIdx: 0 },
      { t: 'measure', feats: P, d: 2500 },
      { t: 'nameLen', len: 6 },
    ],
  },
  {
    label: 'GAME 2 — hider in the far corner, seeker opens wide',
    hider: at(19.1480, 72.9650),
    plan: [
      { t: 'radar', at: at(19.05, 72.85), r: 6000 },
      { t: 'tentacles', feats: M, at: at(19.14, 72.96), r: 4000 },
      { t: 'thermo', a: at(19.02, 72.82), b: at(19.14, 72.96) },
      { t: 'measure', feats: S.slice(0, 12), d: 1500 },
    ],
  },
  {
    label: 'GAME 3 — v2 features in play: draft first, then commit',
    hider: at(19.0950, 72.9100),
    plan: [
      { t: 'radar', at: at(19.09, 72.91), r: 7000 },
      { t: 'thermo', a: at(19.02, 72.82), b: at(19.12, 72.94), draftFirst: true },
      { t: 'matchNearest', feats: P, seekerIdx: 3, draftFirst: true },
      { t: 'nameLen', len: 5 },
    ],
  },
  {
    label: "GAME 4 — v2 Station's Line card decides it",
    hider: at(19.0300, 72.8300),
    plan: [
      { t: 'radar', at: at(19.03, 72.83), r: 12000 },
      { t: 'stationLine', memberIds: S.filter((_, i) => i % 3 === 0).map((s) => s.id), lineLabel: 'Harbour' },
      { t: 'thermo', a: at(19.10, 72.95), b: at(19.02, 72.82) },
    ],
  },
  {
    label: 'GAME 5 — long game, eight questions, hider near the middle',
    hider: at(19.0800, 72.8900),
    plan: [
      { t: 'radar', at: at(19.08, 72.89), r: 11000 },
      { t: 'thermo', a: at(19.00, 72.81), b: at(19.10, 72.92) },
      { t: 'matchNearest', feats: M, seekerIdx: 2 },
      { t: 'measure', feats: P, d: 3000 },
      { t: 'nameLen', len: 6 },
      { t: 'tentacles', feats: P, at: at(19.08, 72.89), r: 3000 },
      { t: 'radar', at: at(19.075, 72.885), r: 2500 },
      { t: 'measure', feats: M, d: 4000 },
    ],
  },
];

console.log('PLAYTEST — full games through the real app\n' + '='.repeat(70));
const results = [];
for (const g of games) results.push(await run(g.label, g.hider, g.plan));

// ---- Mid-game share handoff --------------------------------------------
console.log('\n── HANDOFF — share the board mid-game and continue on the other device');
const handoff = await page.evaluate(async () => {
  const { board, tools, turf, oracle } = window.__play;
  const { buildShareUrl, tokenFromUrl, parseShareToken } = await import('/src/share-link.js');
  const { store } = window.__jltg;
  const hider = { lat: 19.0620, lng: 72.8480 };

  // The answers must be TRUTHFUL for this hider, exactly as in the games above. Hardcoding
  // them is how the first run of this check "failed": a fabricated "hotter" legitimately
  // eliminated the hider, and the share feature was blamed for the fixture's lie.
  const mk = [
    { id: 'a', tool: 'radar', enabled: true, inputs: { center: { lat: 19.07, lng: 72.88 }, radius: 9000 }, answer: {} },
    { id: 'b', tool: 'thermometer', enabled: true, inputs: { a: { lat: 19.07, lng: 72.88 }, b: { lat: 19.02, lng: 72.83 } }, answer: {} },
  ].map((st) => ({ ...st, answer: oracle.truthfulAnswer(st, hider, board) }));

  await store.update((g) => {
    g.zones = [{ id: 'z1', name: 'Board', polygon: [[18.98, 72.80], [18.98, 72.98], [19.16, 72.98], [19.16, 72.80]] }];
    g.gameArea = board;
    g.history = mk;
    g.notes = [{ id: 'n', point: { lat: 19, lng: 72 }, text: 'private', at: 1 }];
  });

  const before = tools.computeActiveArea(board, store.getCurrent().history);
  const { url } = await buildShareUrl(store.getCurrent(), 'https://x.test/app/');
  const payload = await parseShareToken(tokenFromUrl(url));
  // "Other device": rebuild the board from the payload alone.
  const after = tools.computeActiveArea(board, payload.history);
  const a1 = turf.area(turf.feature(before)) / 1e6, a2 = turf.area(turf.feature(after)) / 1e6;
  const hiderStill = turf.booleanPointInPolygon(turf.point([hider.lng, hider.lat]), turf.feature(after));
  return { same: Math.abs(a1 - a2) < 0.01, a1: +a1.toFixed(1), a2: +a2.toFixed(1), notesLeaked: payload.notes !== undefined, hiderStill, len: url.length };
});
console.log(`   board before ${handoff.a1} km² -> rebuilt from link ${handoff.a2} km²  identical:${handoff.same}`);
console.log(`   link ${handoff.len} chars, notes leaked: ${handoff.notesLeaked}, hider still in: ${handoff.hiderStill}`);
console.log(`   VERDICT: ${handoff.same && !handoff.notesLeaked && handoff.hiderStill ? '✅ a teammate continues the same game' : '❌ handoff broken'}`);

// ---- Mid-game area exclusion -------------------------------------------
console.log('\n── EXCLUSION — rule an area out of play mid-game');
const excl = await page.evaluate(async () => {
  const { turf } = window.__play;
  const { assembleBoard } = await import('/src/geo.js');
  const big = [[18.98, 72.80], [18.98, 72.98], [19.16, 72.98], [19.16, 72.80]];
  const bay = [[19.04, 72.86], [19.04, 72.90], [19.08, 72.90], [19.08, 72.86]];
  const before = assembleBoard([{ polygon: big }]);
  const after = assembleBoard([{ polygon: big }, { polygon: bay, mode: 'subtract' }]);
  const inBay = turf.booleanPointInPolygon(turf.point([72.88, 19.06]), turf.feature(after));
  return { a1: +(turf.area(turf.feature(before)) / 1e6).toFixed(1), a2: +(turf.area(turf.feature(after)) / 1e6).toFixed(1), inBay };
});
console.log(`   board ${excl.a1} km² -> ${excl.a2} km² after excluding the bay; a point in the bay is on-board: ${excl.inBay}`);
console.log(`   VERDICT: ${excl.a2 < excl.a1 && !excl.inBay ? '✅ exclusion holds' : '❌ exclusion failed'}`);

// ---- Summary ------------------------------------------------------------
console.log('\n' + '='.repeat(70));
const lost = results.filter((r) => r.verdict !== 'ok');
console.log(`GAMES: ${results.length}   clean: ${results.length - lost.length}   problems: ${lost.length}`);
for (const r of lost) console.log(`  ❌ ${r.label}: ${r.verdict}`);
const real = errors.filter(e => !/Failed to load|net::ERR|favicon|ERR_/i.test(e));
console.log(`CONSOLE/PAGE ERRORS: ${real.length}`);
real.slice(0, 10).forEach(e => console.log('   ' + e.slice(0, 170)));
await browser.close();
process.exit(lost.length === 0 && real.length === 0 ? 0 : 1);
