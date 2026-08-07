// Station's Line, after the persistent station set was dropped: the confirm step.
//
// The card now sources stations per question and asks the seeker to confirm them before
// committing. That sheet is the safeguard for a sourcing path built on heuristics (OSM
// tagging, a 100 m tolerance to the way), so what it shows and what it commits both matter.
//
// Browser-driven because none of it is reachable from node. The PURE half — which stations
// are on the line and what else they serve — is covered in test/stations-on-line.test.mjs,
// and the geometry in test/station-line-selfsourced.test.mjs.
//
// Not part of `npm test` (needs Playwright + a served copy):
//   npx http-server -p 8899 -s .   then   node test/station-line-e2e.mjs
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
  window.JLTG_CONFIG = { GOOGLE_MAPS_API_KEY: 'stub', OVERPASS_PROXY_URL: 'http://stub', MULTIPLAYER_URL: '' };
});
await page.route('**/*', r => r.request().url().startsWith('http://127.0.0.1:8899') ? r.continue() : r.fulfill({ status: 204, body: '' }));
await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__jltg, { timeout: 30000 });
await page.waitForTimeout(3000);

const results = [];
const check = (n, ok, d='') => { results.push(ok); console.log(`${ok?'  ok  ':' FAIL '} ${n}${d?` — ${d}`:''}`); };
const sheetText = () => page.evaluate(() => document.querySelector('.sheet')?.innerText || '(no sheet)');

// A board, then the confirm sheet driven directly with a fixture. The line picker (step 1)
// and the OSM lookup are not exercised here: ES module namespaces are frozen, so
// candidateLines cannot be stubbed from the page, and the membership logic it feeds is
// covered purely in test/stations-on-line.test.mjs. What is browser-only is this sheet.
await page.evaluate(async () => {
  const { store } = window.__jltg;
  await store.newGame({ name: 'stationline e2e' });
  await window.__jltg.zones.addZone('board', [[18.98,72.80],[18.98,72.98],[19.16,72.98],[19.16,72.80]], {});
  store.update(g => { g.settings = { ...g.settings, hidingRadiusM: 800 }; });
});

const CARD = { id: 'rail_station', label: "Station's Line", lineKind: 'rail' };
const LINE = { id: 'w', label: 'Western Line' };
// What _stationsOnLine returns: on-line stations, each tagged with every line it serves.
const FOUND = [
  { id: 'osm:1', name: 'Andheri', lat: 19.02, lng: 72.85, lines: ['Western Line'] },
  { id: 'osm:2', name: 'Bandra',  lat: 19.06, lng: 72.85, lines: ['Western Line'] },
  { id: 'osm:3', name: 'Dadar',   lat: 19.10, lng: 72.85, lines: ['Western Line', 'Central Line'] },
];

await page.evaluate(({ card, line, found }) => {
  window.__picked = window.__jltg.layers._stationLineCandidates(card, line, found);
}, { card: CARD, line: LINE, found: FOUND });
await page.waitForTimeout(600);

let t = await sheetText();
check('the confirm sheet is titled for the line', /Western Line — stations/.test(t), t.split('\n')[0]);
check('it lists the sourced stations', /Andheri/.test(t) && /Bandra/.test(t) && /Dadar/.test(t));
check('an interchange names its other line', t.includes('Dadar \u2014 also Central Line'), JSON.stringify(t.slice(t.indexOf('Dadar'), t.indexOf('Dadar')+30)));
check('a single-line station says so', t.includes('Andheri \u2014 Western Line only'), JSON.stringify(t.slice(t.indexOf('Andheri'), t.indexOf('Andheri')+30)));
check('manual add is offered', /Add by tap/.test(t));
check('all start ticked', /Use selected \(3\)/.test(t), (t.match(/Use selected.*/)||[''])[0]);

// Untick Bandra — the seeker's correction, the whole reason this step exists.
await page.evaluate(() => {
  const cb = [...document.querySelectorAll('input[data-idx]')][1];
  cb.checked = false; cb.dispatchEvent(new Event('change'));
});
await page.waitForTimeout(400);
t = await sheetText();
check('unticking updates the count live', /Use selected \(2\)/.test(t), (t.match(/Use selected.*/)||[''])[0]);

await page.evaluate(() => document.querySelector('#slc-done').click());
const picked = await page.evaluate(() => window.__picked.then(v => v && v.map(x => x.name)));
check('only the ticked stations are returned', JSON.stringify(picked) === JSON.stringify(['Andheri','Dadar']), String(picked));

// Step 3 — the answer sheet, then commit.
//
// No seed argument: the sheet is asked to work out its own prefill, which is the path the app
// actually takes. The radius is TYPED HERE now, not set in Settings — that card was its only
// consumer, so a seeker used to meet it long before it meant anything and then had to leave
// the question flow to go and set it.
await page.evaluate(async ({ card, line }) => {
  const chosen = await window.__picked;
  window.__jltg.layers._stationLineAnswer(card, line, chosen);
}, { card: CARD, line: LINE });
await page.waitForTimeout(600);
t = await sheetText();
check('the answer sheet asks same/different', /Did the hider answer the same/.test(t), t.split('\n')[0]);
check('it names the line and the confirmed count', /Western Line/.test(t) && /2 stations confirmed/.test(t));
check('it asks for the hiding radius in metres', /Hiding radius/i.test(t) && /In metres, 1[–-]100000/.test(t), (t.match(/In metres.*/) || [''])[0]);

const field = await page.evaluate(() => {
  const el = document.querySelector('#sl-radius');
  return el ? { value: el.value, min: el.getAttribute('min'), max: el.getAttribute('max'), step: el.getAttribute('step') } : null;
});
check('the field exists and is bounded 1–100000', field?.min === '1' && field?.max === '100000', JSON.stringify(field));
check('step="any" — a typed value is not snapped to a rung', field?.step === 'any', String(field?.step));
check('it prefills from the radius this board last used', field?.value === '800', String(field?.value));

// Out of range is REJECTED, never clamped: a mistyped 100001 must not commit a 100 km
// elimination the seeker never agreed to. The sheet stays open and nothing is stored.
await page.evaluate(() => {
  const el = document.querySelector('#sl-radius'); el.value = '100001';
  document.querySelector('#sl-add').click();
});
await page.waitForTimeout(500);
check('over the ceiling does not commit', await page.evaluate(() => !(window.__jltg.store.getCurrent().history || []).some(x => x.inputs?.mode === 'stationLine')));
check('the sheet stays open after a rejection', await page.evaluate(() => !!document.querySelector('#sl-radius')));
check('the rejected number is left alone, not rewritten', await page.evaluate(() => document.querySelector('#sl-radius')?.value) === '100001');

// A custom value no preset ever offered — the point of the change.
await page.evaluate(() => {
  const el = document.querySelector('#sl-radius'); el.value = '1250';
  document.querySelector('#sl-add').click();
});
await page.waitForTimeout(800);

const step = await page.evaluate(() => {
  const g = window.__jltg.store.getCurrent();
  const s = (g.history || []).find(x => x.inputs?.mode === 'stationLine');
  return s ? { n: s.inputs.stations.length, ids: s.inputs.stations.map(x => x.id), members: s.inputs.memberIds,
               radius: s.inputs.radiusM, label: s.inputs.lineLabel, match: s.answer?.match,
               names: s.inputs.stations.map(x => x.name) } : null;
});
check('a step was committed', !!step, JSON.stringify(step));
check('it carries ONLY the confirmed stations', step?.n === 2, `${step?.n} stations: ${step?.names}`);
check('the unticked station is absent', !step?.ids.includes('osm:2'), String(step?.ids));
check('every carried station is a member', JSON.stringify(step?.ids) === JSON.stringify(step?.members));
check('the radius is the one typed on the sheet, not a Settings value', step?.radius === 1250, String(step?.radius));
check('the board remembers it as the next prefill', await page.evaluate(() => window.__jltg.store.getCurrent().settings?.hidingRadiusM) === 1250);
check('the line label is stored', step?.label === 'Western Line');
check('no page errors', errs.length === 0, errs.join(' | '));

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
