// The Stations panel after the list became a late-game shortlist.
//
// Half of these assert ABSENCE — no OSM/Places sourcing, no "Lock in this set", no
// eliminate-by-line, no range picker. Absence is the thing a unit test cannot see and the
// thing most likely to creep back, since every one of those was a button in this same sheet.
//
// The rest cover what survived: tap to add, strike off, and the three kept behaviours
// (markers, long-press chooser, manual elimination) still working on the smaller list.
//
// Not part of `npm test` (needs Playwright + a served copy):
//   npx http-server -p 8899 -s .   then   node test/stations-panel-e2e.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.addInitScript(() => {
  const h = { get(t,p){ if(p==='then')return undefined; if(!(p in t)) t[p]=new Proxy(function(){return new Proxy({},h)},h); return t[p]; }, apply(){return new Proxy({},h)}, construct(){return new Proxy({},h)} };
  const maps = new Proxy(function(){}, h);
  maps.event = { addListener: () => ({remove(){}}), removeListener(){}, clearInstanceListeners(){}, trigger(){} };
  maps.SymbolPath = { CIRCLE: 0 };
  maps.LatLngBounds = function(){ return { extend(){}, isEmpty: () => true, getCenter: () => ({lat:()=>19,lng:()=>72}) }; };
  maps.Marker = function(o){ return { setMap(){}, addListener: () => ({remove(){}}), ...o }; };
  maps.Map = function(){ return new Proxy({ addListener: () => ({remove(){}}), setCenter(){}, fitBounds(){}, getCenter: () => ({lat:()=>19,lng:()=>72}), setOptions(){}, controls: [] }, h); };
  window.google = { maps };
  window.JLTG_CONFIG = { GOOGLE_MAPS_API_KEY: 'stub', OVERPASS_PROXY_URL: '', MULTIPLAYER_URL: '' };
});
await page.route('**/*', r => r.request().url().startsWith('http://127.0.0.1:8899') ? r.continue() : r.fulfill({ status: 204, body: '' }));
await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__jltg, { timeout: 30000 });
await page.waitForTimeout(3000);

const results = [];
const check = (n, ok, d='') => { results.push(ok); console.log(`${ok?'  ok  ':' FAIL '} ${n}${d?` — ${d}`:''}`); };
const sheet = () => page.evaluate(() => document.querySelector('.sheet')?.innerText || '(none)');

await page.evaluate(async () => {
  const { store } = window.__jltg;
  await store.newGame({ name: 'stations panel' });
  await window.__jltg.zones.addZone('board', [[18.98,72.80],[18.98,72.98],[19.16,72.98],[19.16,72.80]], {});
});

// Empty state.
await page.evaluate(() => window.__jltg.games.openStations());
await page.waitForTimeout(500);
let t = await sheet();
check('panel opens', /Stations/.test(t), t.split('\n')[0]);
check('no OSM source button', !/Source from OSM/.test(t));
check('no Places source button', !/Google Places/.test(t));
check('no "Lock in this set"', !/Lock in/.test(t));
check('no eliminate-by-line block', !/Eliminate by line/.test(t));
check('no Range… action', !/Range…/.test(t));
check('tap-to-add is offered', /Add stations \(tap map\)/.test(t));
check('empty state points at tapping', /tap the map/i.test(t), (t.match(/No stations yet.*/)||[''])[0]);

// With a shortlist.
await page.evaluate(async () => {
  const { store } = window.__jltg;
  const { makeManualStation } = await import('/src/stations.js');
  store.update(g => { g.stations = { list: [
    makeManualStation({ lat: 19.02, lng: 72.85 }, 1),
    makeManualStation({ lat: 19.06, lng: 72.88 }, 2),
    makeManualStation({ lat: 19.10, lng: 72.91 }, 3),
  ] }; });
  document.querySelector('.sheet-backdrop, .sheet')?.remove();
  window.__jltg.games.openStations();
});
await page.waitForTimeout(500);
t = await sheet();
check('the shortlist renders', /Station 1/.test(t) && /Station 3/.test(t));
check('it reports how many are in play', /3 still in play of 3/.test(t), (t.match(/\d+ still in play.*/)||[''])[0]);
check('clear is enabled with entries', await page.evaluate(() => !document.querySelector('#st-clear')?.disabled));

// Strike one off from the panel.
await page.evaluate(() => {
  const cb = document.querySelectorAll('.st-elim')[1];
  cb.checked = true; cb.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(600);
t = await sheet();
check('striking one off updates the count', /2 still in play of 3/.test(t), (t.match(/\d+ still in play.*/)||[''])[0]);
const state = await page.evaluate(() => window.__jltg.store.getCurrent().stations.list.map(s => [s.name, !!s.eliminated, s.eliminatedBy]));
check('it persists with a manual tag', JSON.stringify(state[1]) === JSON.stringify(['Station 2', true, 'manual']), JSON.stringify(state));

// Map markers + long-press chooser survive (kept items #1/#3/#5).
const menu = await page.evaluate(async () => {
  const m = await import('/src/stations-layer.js');
  return m.stationLongPressActions({ id: 'x', eliminated: false }).map(a => a.id);
});
check('long-press chooser still offers note + toggle', JSON.stringify(menu) === JSON.stringify(['note','toggle']), String(menu));
check('no zone drill-down action returned', !menu.includes('zone'));

// Share link carries the shortlist.
const shared = await page.evaluate(async () => {
  const { toSharePayload } = await import('/src/share-link.js');
  const p = toSharePayload(window.__jltg.store.getCurrent());
  return { n: p.stations?.length, elim: p.stations?.filter(s => s.eliminated).length, old: p.stationEliminations };
});
check('the share link carries the shortlist', shared.n === 3, JSON.stringify(shared));
check('with its eliminations', shared.elim === 1);
check('and not the old write-only field', shared.old === undefined);

check('no page errors', errs.length === 0, errs.join(' | '));
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
