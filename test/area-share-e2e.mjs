// Play-area sharing, driven through the real UI on two "phones" (two isolated browser contexts,
// so no IndexedDB or clipboard is shared between them — exactly like two devices).
//
// Phone A builds a board with an exclusion, opens Zones ▸ 📤 Share area and reads the text and
// the area check. Phone B pastes that text into Zones ▸ ⇩ Import area. Both must end up on the
// same board: same zone count, the exclusion still an exclusion, the same area to 0.01 km², and
// the same area-check code shown in each phone's Zones panel.
//
// Not part of `npm test` (needs Playwright + a served copy):
//   npx http-server -p 8899 -s .   then   node test/area-share-e2e.mjs
// Set BASE_URL to run it against a deployed copy instead (Google Maps is still stubbed, so
// this checks the app's code, not the Maps key).
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8899/';
const SHOTS = process.env.SHOTS || null;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });

async function phone(label) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`${label}: ${e.message}`));
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
  const origin = new URL(BASE).origin;
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(origin) && !/\/config\.js(\?|$)/.test(u)) return r.continue();
    return r.fulfill({ status: 204, body: '' });
  });
  await page.goto(new URL('index.html', BASE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__jltg, { timeout: 30000 });
  await page.waitForTimeout(1500);
  return { page, errs, ctx };
}

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '  ok  ' : ' FAIL '} ${n}${d ? ` — ${d}` : ''}`); };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

const A = await phone('A');
const B = await phone('B');

// --- Phone A: a board with a hole ---
const big = [[19.00, 72.80], [19.00, 72.98], [19.16, 72.98], [19.16, 72.80]];
const hole = [[19.05, 72.85], [19.05, 72.88], [19.08, 72.88], [19.08, 72.85]];
await A.page.evaluate(async ([big, hole]) => {
  await window.__jltg.zones.addZone('Main board', big, {});
  await window.__jltg.zones.addZone('The bay', hole, { mode: 'subtract' });
}, [big, hole]);

await A.page.click('#toolbar [data-act="zones"]');
await A.page.waitForSelector('#z-export');
const aPanel = await A.page.locator('.sheet.open').innerText();
const aFp = (aPanel.match(/area check #([0-9A-F]{6})/) || [])[1];
check('A: Zones panel shows an area check', !!aFp, aFp);
check('A: Share area button is enabled', await A.page.isEnabled('#z-export'));
await shot(A.page, 'A1-zones-panel');

await A.page.click('#z-export');
await A.page.waitForSelector('#ax-text');
const text = await A.page.inputValue('#ax-text');
const exportSheet = await A.page.locator('.sheet.open').innerText();
check('A: export sheet repeats the same area check', exportSheet.includes(`#${aFp}`));
check('A: export sheet says one zone is excluded', /\(1 excluded\)/.test(exportSheet), exportSheet.split('\n').find((l) => /zone/.test(l)));
let parsed = null; try { parsed = JSON.parse(text); } catch {}
check('A: exported text is GeoJSON', parsed?.type === 'FeatureCollection' && parsed.features.length === 2);
check('A: the exclusion is marked in the text', parsed?.features?.[1]?.properties?.mode === 'subtract');
await shot(A.page, 'A2-export-sheet');

// --- Phone B: paste into Zones ▸ Import area ---
await B.page.click('#toolbar [data-act="zones"]');
await B.page.waitForSelector('#z-import');
check('B: Share area is disabled on an empty board', !(await B.page.isEnabled('#z-export')));
await B.page.click('#z-import');
await B.page.waitForSelector('#imp');
await B.page.fill('#imp', text);
await shot(B.page, 'B1-import-sheet');
await B.page.click('#imp-go');
await B.page.waitForTimeout(800);
const bToast = await B.page.evaluate(() => document.getElementById('toast')?.textContent || '');
check('B: import toast reports the area check', bToast.includes(`#${aFp}`), bToast);

const stateOf = (page) => page.evaluate(() => {
  const g = window.__jltg.store.getCurrent();
  return {
    zones: g.zones.length,
    subtract: g.zones.filter((z) => z.mode === 'subtract').map((z) => z.name),
    km2: g.gameArea ? window.turf.area(window.turf.feature(g.gameArea)) / 1e6 : 0,
  };
});
const sa = await stateOf(A.page), sb = await stateOf(B.page);
check('B: same number of zones as A', sa.zones === sb.zones, `${sa.zones} vs ${sb.zones}`);
check('B: the bay is still excluded', sb.subtract.length === 1 && sb.subtract[0] === 'The bay', JSON.stringify(sb.subtract));
check('B: same play-area size as A', Math.abs(sa.km2 - sb.km2) < 0.01, `${sa.km2.toFixed(3)} vs ${sb.km2.toFixed(3)} km²`);

// A successful import reopens the Zones panel by itself (zones.js _openImport), which is where
// the receiver reads their code aloud.
await B.page.waitForSelector('.sheet.open #z-export');
const bPanel = await B.page.locator('.sheet.open').innerText();
const bFp = (bPanel.match(/area check #([0-9A-F]{6})/) || [])[1];
check('B: Zones panel shows the SAME area check as A', bFp === aFp, `${bFp} vs ${aFp}`);
check('B: the excluded zone is listed as excluded', /The bay.*excluded/s.test(bPanel));
await shot(B.page, 'B2-zones-after-import');

check('no page errors', A.errs.length + B.errs.length === 0, [...A.errs, ...B.errs].join(' | '));
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
