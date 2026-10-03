// The seeker's "📤 Copy for hider" panel, driven through the real question sheets.
//
// For each question whose reference the seekers choose, the panel must be THERE; for one the app
// sources automatically it must NOT be. Opening it shows the seekers' side in words before any
// copy, refuses with a reason when that side is missing, follows edits made after it was opened,
// and copies text the hider's parser reads back to the same question.
//
// Not part of `npm test` (needs Playwright + a served copy):
//   npx http-server -p 8899 -s .   then   node test/ref-share-e2e.mjs
import { launch, phone, checker, openSheetText, BOARD } from './helpers/e2e-phone.mjs';

const SHOTS = process.env.SHOTS || null;
const browser = await launch();
const { check, done } = checker();
const S = await phone(browser, 'seeker');
const page = S.page;
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

await page.evaluate(async (b) => { await window.__jltg.zones.addZone('Board', b, {}); }, BOARD);
await page.waitForTimeout(300);

// Reads the clipboard the way the hider's paste would receive it, and parses it with the app's
// own parser (the module the hider's phone loads).
const clipboardRef = () => page.evaluate(async () => {
  const text = await navigator.clipboard.readText();
  const { parseQuestionRef } = await import('./src/question-ref.js');
  try { return { ok: true, text, ref: parseQuestionRef(text) }; } catch (e) { return { ok: false, text, err: e.message }; }
});
const has = (sel) => page.locator(`.sheet.open ${sel}`).count().then((n) => n > 0);
const summary = () => page.locator('.sheet.open #sr-summary').innerText();
const status = () => page.locator('.sheet.open #sr-status').innerText();

// ---------------- Measuring: a hand-drawn coastline ----------------
const LINE = { type: 'LineString', coordinates: [[72.80, 19.00], [72.82, 19.05], [72.85, 19.10]] };
await page.evaluate((LINE) => window.__jltg.layers._distanceSheet({ id: 'coastline', label: 'Coastline' }, { refType: 'line', refLabel: 'Coastline', refGeometry: LINE }), LINE);
await page.waitForSelector('.sheet.open #sr-open');
check('measuring (drawn line): the 📤 panel is offered', await has('#sr-open'));
await page.fill('.sheet.open #m-dist', '');
await page.click('.sheet.open #sr-open');
check('opening with no distance refuses, with a reason', /Enter your distance first/.test(await status()), await status());
check('…and nothing can be copied yet', await page.isDisabled('.sheet.open #sr-copy'));
await page.fill('.sheet.open #m-dist', '1.2');
await page.selectOption('.sheet.open #m-dist-unit', 'km');
await page.waitForTimeout(150);
const sum1 = await summary();
check('the preview names the question and the line', /Measuring · Coastline/.test(sum1) && /1 line/.test(sum1), sum1.replace(/\n/g, ' '));
check('the preview shows the seekers\' distance in words, for checking', /Seekers' distance to the nearest coastline: 1\.20 km/.test(sum1));
await shot('B1-measuring-line-preview');
// Edit AFTER opening: the copy must carry the new number, not the previewed one.
await page.fill('.sheet.open #m-dist', '1.5');
await page.waitForTimeout(150);
check('the preview follows an edit made after it was opened', /1\.50 km/.test(await summary()));
await page.click('.sheet.open #sr-copy');
await page.waitForTimeout(200);
let c = await clipboardRef();
check('Copy puts a parseable question on the clipboard', c.ok, c.err || '');
check('…carrying the drawn line vertex-for-vertex', c.ok && c.ref.lines[0].paths[0].length === 3 && c.ref.lines[0].paths[0][1].lat === 19.05);
check('…and the edited distance (1500 m), not the first one', c.ok && c.ref.seeker.distanceM === 1500, c.ok ? String(c.ref.seeker.distanceM) : '');
check('the message opens with a plain-English instruction line', /^JLTG question for the hider — Measuring · Coastline\. Paste this whole message into Questions ▸ 📥 Received question\./.test(c.text));
check('the copy confirmation tells the seeker where the hider pastes it', /Received question/.test(await status()));

// ---------------- Measuring: an OSM-sourced coastline is NOT offered ----------------
await page.evaluate((LINE) => window.__jltg.layers._distanceSheet({ id: 'coastline', label: 'Coastline' }, { refType: 'line', refLabel: 'Coastline', refSource: 'osm', refGeometry: LINE }), LINE);
await page.waitForSelector('.sheet.open #m-add');
check('measuring (OSM-sourced line): no 📤 panel', !(await has('#sr-open')));

// ---------------- Matching nearest: the seekers' own pick is required ----------------
const POIS = [
  { lat: 19.07, lng: 72.87, name: 'Museum A' }, { lat: 19.08, lng: 72.86, name: 'Museum B' }, { lat: 19.06, lng: 72.89, name: 'Museum C' },
];
await page.evaluate((POIS) => window.__jltg.layers._matchNearestSelect({ id: 'museum', label: 'Museum' }, POIS), POIS);
await page.waitForSelector('.sheet.open #sr-open');
await page.click('.sheet.open #sr-open');
check('matching nearest: refuses until the seeker picks their nearest', /Pick which one is nearest to you first/.test(await status()));
await page.check('.sheet.open input[name="mt-feat"][value="1"]');
await page.waitForTimeout(150);
check('…then shows the seekers\' nearest by number and name', /Seekers' nearest: #2 Museum B/.test(await summary()), (await summary()).replace(/\n/g, ' '));
await shot('B2-matching-nearest-preview');
await page.click('.sheet.open #sr-copy');
await page.waitForTimeout(200);
c = await clipboardRef();
check('…and the copied list is the ticked list, numbered as on the map', c.ok && c.ref.pois.map((p) => p.name).join('|') === 'Museum A|Museum B|Museum C' && c.ref.seeker.nearest === 2);
check('the hider\'s answer radio is NOT in the message', c.ok && !/"keep"|"match"/.test(c.text));

// ---------------- Matching nearest-line: drawn yes, sourced no ----------------
const LINES = [
  { id: 'ln_0_a', label: 'Harbour path', coords: [{ lat: 19.0, lng: 72.8 }, { lat: 19.05, lng: 72.85 }] },
  { id: 'ln_1_b', label: 'Ridge path', coords: [{ lat: 19.1, lng: 72.8 }, { lat: 19.12, lng: 72.86 }] },
];
await page.evaluate((LINES) => window.__jltg.layers._nearestLineSheet({ id: 'street', label: 'Street or Path' }, LINES, { sourced: false }), LINES);
await page.waitForSelector('.sheet.open #sr-open');
check('matching (drawn lines): the 📤 panel is offered', await has('#sr-open'));
await page.check('.sheet.open input[name="ln"][value="ln_1_b"]');
await page.click('.sheet.open #sr-open');
check('…naming the seekers\' nearest line', /Seekers' nearest line: Ridge path/.test(await summary()));
await page.evaluate((LINES) => window.__jltg.layers._nearestLineSheet({ id: 'transit_line', label: 'Transit Line' }, LINES.map((l) => ({ ...l, paths: [l.coords.map((p) => [p.lat, p.lng])] })), { sourced: true }), LINES);
await page.waitForSelector('.sheet.open #ln-add');
check('matching (OSM-sourced lines): no 📤 panel', !(await has('#sr-open')));

// ---------------- Region (matching admin division): drawn, no extra seeker field ----------------
await page.evaluate(() => {
  const L = window.__jltg.layers;
  L._drawShape = async () => [{ lat: 19.0, lng: 72.8 }, { lat: 19.0, lng: 72.9 }, { lat: 19.1, lng: 72.9 }, { lat: 19.1, lng: 72.8 }];
  L._adminTracePrompt = async () => () => {};
  L._matchRegion({ id: 'admin2', label: '2nd Admin. Division', mode: 'region' });
});
await page.waitForSelector('.sheet.open #sr-open');
await page.click('.sheet.open #sr-open');
check('matching region: offered, and says the outline is the seekers\' region', /the one the seekers are in/.test(await summary()), (await summary()).replace(/\n/g, ' '));
await page.click('.sheet.open #sr-copy');
await page.waitForTimeout(200);
c = await clipboardRef();
check('…copied as a 4-vertex region', c.ok && c.ref.polygons[0].ring.length === 4 && c.ref.card === 'admin2');

// ---------------- Tentacles: places + centre + reach ----------------
await page.evaluate((POIS) => window.__jltg.layers._chooseTentacle({ id: 'museum', label: 'Museums', radius: 2000 }, POIS, { lat: 19.07, lng: 72.87 }), POIS);
await page.waitForSelector('.sheet.open #sr-open');
await page.click('.sheet.open #sr-open');
check('tentacles: the preview names the reach circle', /within 2\.00 km of the seekers/.test(await summary()), (await summary()).replace(/\n/g, ' '));
await page.click('.sheet.open #sr-copy');
await page.waitForTimeout(200);
c = await clipboardRef();
check('…copied with the seekers\' centre and the 2 km reach', c.ok && c.ref.radiusM === 2000 && c.ref.center?.lat === 19.07);
await shot('B3-tentacles-preview');

// ---------------- Committed questions: 📤 on shareable rows only ----------------
await page.evaluate((POIS) => {
  const L = window.__jltg.layers;
  L.addStep('radar', { center: { lat: 19.07, lng: 72.87 }, radius: 1000 }, { side: 'in' });
  L.addStep('matching', { mode: 'nearest', category: 'museum', categoryLabel: 'Museum', features: POIS }, { featureIndex: 2, keep: true });
  L.addStep('measuring', { refType: 'line', refLabel: 'Coastline', refSource: 'osm', refGeometry: { type: 'LineString', coordinates: [[72.8, 19], [72.9, 19.1]] }, distance: 900 }, { side: 'in' });
}, POIS);
await page.evaluate(() => window.__jltg.layers.openPanel());
await page.waitForSelector('.sheet.open [data-toggle]');
const rows = await page.$$eval('.sheet.open .list li', (lis) => lis.map((li) => ({ text: li.innerText.split('\n')[0], share: !!li.querySelector('[data-share]') })));
check('radar row: no 📤', rows.some((r) => /Radar/.test(r.text) && !r.share), JSON.stringify(rows.map((r) => [r.text.slice(0, 30), r.share])));
check('matching (ticked list) row: 📤', rows.some((r) => /Matching · Museum/.test(r.text) && r.share));
check('measuring (OSM coastline) row: no 📤', rows.some((r) => /Measuring/.test(r.text) && !r.share));
await shot('B4-questions-panel');
// The pre-existing floating "📍 Location on" pill can sit over a row's buttons in a headless
// viewport; dispatch the tap on the button itself rather than at screen coordinates.
await page.$eval('.sheet.open [data-share]', (b) => b.click());
await page.waitForSelector('.sheet.open #sr-summary');
await page.waitForTimeout(150);
const sendSheet = await openSheetText(page);
check('the row\'s sheet opens already expanded, with the seekers\' nearest', /Send to hider/.test(sendSheet) && /Seekers' nearest: #3 Museum C/.test(sendSheet));
check('…and says the hider\'s answer is not included', /hider's answer is not included/.test(sendSheet));
await shot('B5-committed-send-sheet');

// ---------------- Wrong box: a question pasted into Zones ▸ Import is refused ----------------
const zonesBefore = await page.evaluate(() => window.__jltg.store.getCurrent().zones.length);
const added = await page.evaluate(async () => window.__jltg.zones.importText(await navigator.clipboard.readText()));
const zonesAfter = await page.evaluate(() => window.__jltg.store.getCurrent().zones.length);
check('a question pasted into Zones ▸ Import adds no zone', added === 0 && zonesAfter === zonesBefore);
check('…and points at Questions ▸ 📥 Received question', /Received question/.test(await page.evaluate(() => document.getElementById('toast')?.textContent || '')));

check('no page errors', S.errs.length === 0, S.errs.join(' | '));
const ok = done();
await browser.close();
process.exit(ok ? 0 : 1);
