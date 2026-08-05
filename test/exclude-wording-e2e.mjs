// The exclusion path must never describe itself as an addition.
//
// The bug: cutting an area OUT of the board toasted `Added "the bay"`, beside a game-area
// figure that had correctly gone DOWN. The sentence described the opposite of what happened,
// which makes the geometry look wrong rather than the wording.
//
// Browser-driven because every one of these strings is assembled at render time and none of
// them is reachable from a unit test. Not part of `npm test` (needs Playwright + a served
// copy):  npx http-server -p 8899 -s .   then   node test/exclude-wording-e2e.mjs
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

// One reusable #toast element, so read its text rather than collecting nodes.
const toastAfter = (fn) => page.evaluate(async (src) => {
  const el = document.getElementById('toast');
  if (el) el.textContent = '';
  await eval(src);
  await new Promise(r => setTimeout(r, 400));
  return (document.getElementById('toast')?.textContent || '(no toast)');
}, fn);

// A board, then a hole cut into it.
const big  = [[19.00,72.80],[19.00,72.98],[19.16,72.98],[19.16,72.80]];
const hole = [[19.05,72.85],[19.05,72.88],[19.08,72.88],[19.08,72.85]];

const addedMsg = await toastAfter(`window.__jltg.zones.addZone('Main board', ${JSON.stringify(big)}, {})`);
check('adding still says "Added"', /Added/.test(addedMsg) && !/Excluded/.test(addedMsg), addedMsg);

const exclMsg = await toastAfter(`window.__jltg.zones.addZone('The bay', ${JSON.stringify(hole)}, { mode: 'subtract' })`);
check('excluding says "Excluded", not "Added"', /^Excluded/.test(exclMsg), exclMsg);
check('excluding never says "Added"', !/Added/.test(exclMsg), exclMsg);
check('area figure still reported', /game area/.test(exclMsg), exclMsg);

// The board must actually have shrunk — the sentence and the geometry agreeing is the point.
const shrank = await page.evaluate(() => {
  const g = window.__jltg.store.getCurrent();
  return { km2: window.turf.area(window.turf.feature(g.gameArea)) / 1e6, zones: g.zones.length,
           tagged: g.zones.filter(z => z.mode === 'subtract').length };
});
check('the excluded area is really cut out', shrank.km2 > 0 && shrank.km2 < 340, `${shrank.km2.toFixed(1)} km² from 2 zones`);
check('the zone is tagged as a subtraction', shrank.tagged === 1);

// The naming sheet's copy.
await page.evaluate(() => { window.__jltg.zones._drawMode = 'subtract'; });
const sheet = await page.evaluate(async () => {
  window.__jltg.zones._draw = { pts: [], preview: null, bar: null, listener: null };
  const ll = (lat, lng) => ({ lat: () => lat, lng: () => lng });
  window.__jltg.zones._draw.pts = [ll(19.05,72.85), ll(19.05,72.88), ll(19.08,72.88)];
  window.__jltg.zones._finishDraw();
  await new Promise(r => setTimeout(r, 500));
  const s = document.querySelector('.sheet');
  return s ? s.innerText : '(no sheet)';
});
check('name sheet titled for an exclusion', /excluded area/i.test(sheet), sheet.split('\n')[0]);
check('name sheet explains the cut-out',    /cut OUT/i.test(sheet));
check('name sheet CTA is not "Save zone"',  !/Save zone/i.test(sheet) && /Exclude this area/i.test(sheet));
check('no page errors', errs.length === 0, errs.join(' | '));

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
