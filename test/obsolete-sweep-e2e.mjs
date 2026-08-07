// Guards the sweep after the station-list removal.
//
// Mostly assertions of ABSENCE, in the two places absence is invisible to a unit test: the
// in-app guide's prose, and what the Games class carries. It also pins the one thing that
// survived and is easy to mistake for a casualty — the Rail panel, which the removed
// eliminate-by-line lived behind but which still feeds Transit Line and Station\'s Line.
//
// The hiding radius has since left Settings too, and its absence there is pinned below: it is
// typed on Station\'s Line\'s own answer sheet now (see test/station-line-e2e.mjs), because
// that card was always its only consumer.
//
// Not part of `npm test` (needs Playwright + a served copy):
//   npx http-server -p 8899 -s .   then   node test/obsolete-sweep-e2e.mjs
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
const results = []; const check = (n, ok, d='') => { results.push(ok); console.log(`${ok?'  ok  ':' FAIL '} ${n}${d?` — ${d}`:''}`); };

// Games must construct and work without the map/lines it no longer needs.
check('Games no longer holds map/lines', await page.evaluate(() => {
  const g = window.__jltg.games; return g.map === undefined && g.lines === undefined;
}));

const guide = await page.evaluate(async () => (await import('/src/guide.js')).guideBodyHTML());
check('guide drops "Lock in the board\'s stations"', !/Lock in/i.test(guide));
check('guide drops OSM/Places station sourcing', !/from OSM or Google Places/i.test(guide));
check('guide drops line-/range- questions', !/line-, range-/i.test(guide));
check('guide describes the shortlist', /shortlist/i.test(guide));
check('guide mentions the share link carries it', /shared link carries the shortlist/i.test(guide));

// Rail is untouched and still live.
check('Rail toolbar button still present', await page.evaluate(() => !!document.querySelector('[data-act="rail"]')));
check('Rail panel object exists', await page.evaluate(() => !!window.__jltg.lines));
const railUsers = await page.evaluate(async () => {
  const l = await import('/src/lines.js');
  return { candidateLines: typeof l.candidateLines, boardBbox: typeof l.boardBbox };
});
check('candidateLines still exported (Transit Line + Station\'s Line)', railUsers.candidateLines === 'function', JSON.stringify(railUsers));

// Settings: no station-ish settings left at all. The hiding radius moved out to the one card
// that ever read it, so a seeker no longer meets it before it can mean anything.
await page.evaluate(() => window.__jltg.games.openSettings());
await page.waitForTimeout(500);
const st = await page.evaluate(() => document.querySelector('.sheet')?.innerText || '');
check('Settings has no Zone display', !/Zone display/i.test(st));
check('Settings no longer offers Hiding radius', !/Hiding radius/i.test(st), st.replace(/\n/g, ' | ').slice(0, 200));
check('no page errors', errs.length === 0, errs.join(' | '));
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await browser.close(); process.exit(results.every(Boolean) ? 0 : 1);
