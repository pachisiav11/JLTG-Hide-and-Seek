// Playtest 2, end to end on two "phones": the seekers send their own line / places, the hider
// pastes them and measures against exactly that — not against Google's version.
//
// Seeker phone: draws a coastline, enters their distance, 📤 Copy for hider. Also a ticked
// museum list with their nearest picked. Also exports the play area.
// Hider phone (with a GPS fix): imports the play area, pastes each message through BOTH ways in
// (📥 Received question, and the card's own "paste the seekers' version"), sees it, measures,
// hides/shows/removes it, reloads, and is refused where it should be.
//
// Not part of `npm test` (needs Playwright + a served copy):
//   npx http-server -p 8899 -s .   then   node test/received-e2e.mjs
import { launch, phone, checker, openSheetText, toastText, BOARD } from './helpers/e2e-phone.mjs';

const SHOTS = process.env.SHOTS || null;
const browser = await launch();
const { check, done } = checker();
const S = await phone(browser, 'seeker');
// The hider stands at (19.00, 72.80). The seekers' coastline runs north–south at 72.81, so the
// hider is ~1.05 km from it — and the seekers say they are 900 m from it.
const H = await phone(browser, 'hider', { fix: { lat: 19.0, lng: 72.8, accuracy: 12 } });
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };
const sheetHas = (p, sel) => p.locator(`.sheet.open ${sel}`).count().then((n) => n > 0);

// ---------------- Seeker: board, coastline message, museum message, area export ----------------
await S.page.evaluate(async (b) => { await window.__jltg.zones.addZone('Board', b, {}); }, BOARD);
const LINE = { type: 'LineString', coordinates: [[72.81, 18.9], [72.81, 19.1]] };
await S.page.evaluate((LINE) => window.__jltg.layers._distanceSheet({ id: 'coastline', label: 'Coastline' }, { refType: 'line', refLabel: 'Coastline', refGeometry: LINE }), LINE);
await S.page.waitForSelector('.sheet.open #sr-open');
await S.page.fill('.sheet.open #m-dist', '900');
await S.page.selectOption('.sheet.open #m-dist-unit', 'm');
await S.page.click('.sheet.open #sr-open');
await S.page.click('.sheet.open #sr-copy');
await S.page.waitForTimeout(200);
const coastMsg = await S.page.evaluate(() => navigator.clipboard.readText());
check('seeker: coastline message copied', /^JLTG question for the hider — Measuring · Coastline/.test(coastMsg));

const POIS = [
  { lat: 19.010, lng: 72.80, name: 'Far Museum' }, { lat: 19.001, lng: 72.80, name: 'Near Museum' }, { lat: 19.005, lng: 72.80, name: 'Mid Museum' },
];
await S.page.evaluate((POIS) => window.__jltg.layers._matchNearestSelect({ id: 'museum', label: 'Museum' }, POIS), POIS);
await S.page.waitForSelector('.sheet.open #sr-open');
await S.page.check('.sheet.open input[name="mt-feat"][value="2"]'); // seekers' nearest: #3 Mid Museum
await S.page.click('.sheet.open #sr-open');
await S.page.click('.sheet.open #sr-copy');
await S.page.waitForTimeout(200);
const museumMsg = await S.page.evaluate(() => navigator.clipboard.readText());
check('seeker: museum message copied', /Matching · Museum/.test(museumMsg));
const areaMsg = await S.page.evaluate(async () => (await import('./src/area-share.js')).exportAreaText(window.__jltg.store.getCurrent()));

// ---------------- Hider: no board yet → the tool pickers point at the 📥 box ----------------
await H.page.evaluate(() => window.__jltg.layers.startMeasuring());
await H.page.waitForTimeout(300);
check('hider with no board: Measuring points at 📥 Received question', /Received question/.test(await toastText(H.page)), await toastText(H.page));

// ---------------- Hider: 📥 Received question with the coastline ----------------
await H.page.evaluate(() => window.__jltg.layers.openPanel());
await H.page.waitForSelector('.sheet.open #t-received');
await H.page.click('.sheet.open #t-received');
await H.page.waitForSelector('.sheet.open #rq-text');
await H.page.fill('.sheet.open #rq-text', `Forwarded from Seekers\n${coastMsg}`);
await shot(H.page, 'C1-received-paste');
await H.page.click('.sheet.open #rq-go');
await H.page.waitForSelector('.sheet.open #rv-gps');
let view = await openSheetText(H.page);
check('hider: the view names the seekers\' question', /Measuring · Coastline/.test(view));
check('hider: …and shows the seekers\' distance', /Seekers' distance to the nearest coastline: 900 m/.test(view), view.split('\n').find((l) => /Seekers'/.test(l)));
check('hider: the seekers\' line is drawn on the map', await H.page.evaluate(() => window.__jltg.received.overlays.length) >= 1);
await H.page.click('.sheet.open #rv-gps');
await H.page.waitForFunction(() => /Your distance/.test(document.querySelector('.sheet.open #rv-aid')?.innerText || ''), null, { timeout: 15000 });
const aid = await H.page.locator('.sheet.open #rv-aid').innerText();
const yours = Number((aid.match(/Your distance to their coastline: ([\d.]+) (m|km)/) || [])[1]) * ((aid.match(/coastline: [\d.]+ (km)/) ? 1000 : 1));
check('hider: measure aid gives the hider\'s distance to THEIR line (~1.05 km)', Math.abs(yours - 1050) < 30, aid.replace(/\n/g, ' '));
check('hider: …with the seekers\' figure beside it', /seekers': 900 m/.test(aid));
check('hider: …and the GPS accuracy', /±12 m/.test(aid));
check('hider: the aid gives no verdict', !/\b(closer|farther|further|same|different|yes|no)\b/i.test(aid));
check('hider: the sheet says the app doesn\'t answer for them', /doesn't answer for you/.test(await openSheetText(H.page)));
await shot(H.page, 'C2-received-view-measured');

// Tap-to-measure: the hider taps a point instead of using GPS.
await H.page.evaluate(() => { window.__jltg.layers.pick = async () => [{ lat: 19.0, lng: 72.809 }]; });
await H.page.click('.sheet.open #rv-tap');
await H.page.waitForFunction(() => /From the point you tapped/.test(document.querySelector('.sheet.open #rv-aid')?.innerText || ''), null, { timeout: 10000 });
const tapAid = await H.page.locator('.sheet.open #rv-aid').innerText();
check('hider: ✋ Tap where I am measures from the tapped point (~105 m)', /coastline: 10[0-9] m/.test(tapAid), tapAid.replace(/\n/g, ' '));
await H.page.click('.sheet.open #rv-done');

// ---------------- Hider: area import, then "pick the question first" ----------------
await H.page.evaluate(async (t) => window.__jltg.zones.importText(t), areaMsg);
await H.page.waitForTimeout(500);
const fps = await Promise.all([S.page, H.page].map((p) => p.evaluate(async () => (await import('./src/area-share.js')).areaFingerprint(window.__jltg.store.getCurrent().zones))));
check('hider: imported the seekers\' play area, same area check', fps[0] && fps[0] === fps[1], fps.join(' vs '));

await H.page.evaluate(() => window.__jltg.layers.startMeasuring());
await H.page.waitForSelector('.sheet.open #m-recv');
await H.page.selectOption('.sheet.open #m-cat', 'water');
await H.page.click('.sheet.open #m-recv');
await H.page.waitForSelector('.sheet.open #rq-text');
check('hider: the in-question paste box is titled for the card', /Seekers' Body of Water/.test(await openSheetText(H.page)));
await H.page.fill('.sheet.open #rq-text', coastMsg);
await H.page.click('.sheet.open #rq-go');
await H.page.waitForTimeout(200);
const refusal = await H.page.locator('.sheet.open #rq-status').innerText();
check('hider: a coastline message pasted under Body of Water is refused', /not Body of Water/.test(refusal) && /Pick Coastline/.test(refusal), refusal);
check('hider: …and nothing was added', await H.page.evaluate(() => window.__jltg.received.list().length) === 1);

await H.page.evaluate(() => window.__jltg.layers.startMatching());
await H.page.waitForSelector('.sheet.open #mt-recv');
await H.page.selectOption('.sheet.open #mt-cat', 'museum');
await H.page.click('.sheet.open #mt-recv');
await H.page.waitForSelector('.sheet.open #rq-text');
await H.page.fill('.sheet.open #rq-text', museumMsg);
await H.page.click('.sheet.open #rq-go');
await H.page.waitForSelector('.sheet.open #rv-gps');
view = await openSheetText(H.page);
check('hider: Matching ▸ Museum accepts the museum message', /Matching · Museum/.test(view));
check('hider: the seekers\' nearest is marked in the list', /3\. Mid Museum — seekers' nearest/.test(view), view.split('\n').filter((l) => /Museum/.test(l)).join(' | '));
await H.page.click('.sheet.open #rv-gps');
await H.page.waitForFunction(() => /nearest to you first/.test(document.querySelector('.sheet.open #rv-aid')?.innerText || ''), null, { timeout: 15000 });
const mAid = await H.page.locator('.sheet.open #rv-aid').innerText();
const order = [...mAid.matchAll(/#(\d) /g)].map((m) => m[1]).join(',');
check('hider: the aid ranks THEIR places by distance from the hider', order === '2,3,1', `${order} — ${mAid.replace(/\n/g, ' ')}`);
await shot(H.page, 'C3-received-matching');
await H.page.click('.sheet.open #rv-done');

// ---------------- Questions panel rows, hide / show, persistence ----------------
await H.page.evaluate(() => window.__jltg.layers.openPanel());
await H.page.waitForSelector('.sheet.open [data-rcv-view]');
const panel = await openSheetText(H.page);
check('hider: Questions panel lists both received questions', /Received from seekers/i.test(panel) && /📥 Measuring · Coastline/.test(panel) && /📥 Matching · Museum/.test(panel), panel.split('\n').filter((l) => /📥|received/i.test(l)).join(' | '));
check('hider: received questions did NOT become questions on this phone', await H.page.evaluate(() => window.__jltg.store.getCurrent().history.length) === 0);
await shot(H.page, 'C4-questions-panel-received');
const before = await H.page.evaluate(() => window.__jltg.received.overlays.length);
await H.page.$eval('.sheet.open [data-rcv-view]', (b) => b.click());
await H.page.waitForSelector('.sheet.open #rv-toggle');
await H.page.click('.sheet.open #rv-toggle');
await H.page.waitForTimeout(200);
const hidden = await H.page.evaluate(() => window.__jltg.received.overlays.length);
check('hider: 🙈 Hide from map removes that reference\'s overlays', hidden < before, `${before} → ${hidden}`);
await H.page.click('.sheet.open #rv-toggle');
await H.page.waitForTimeout(200);
check('hider: 👁 Show on map puts them back', await H.page.evaluate(() => window.__jltg.received.overlays.length) === before);
await H.page.click('.sheet.open #rv-done');

await H.page.waitForTimeout(800); // let the debounced autosave land
await H.page.reload({ waitUntil: 'domcontentloaded' });
await H.page.waitForFunction(() => !!window.__jltg, { timeout: 30000 });
await H.page.waitForTimeout(1200);
const after = await H.page.evaluate(() => ({ n: window.__jltg.received.list().length, drawn: window.__jltg.received.overlays.length }));
check('hider: received questions survive a reload, and are redrawn', after.n === 2 && after.drawn === before, JSON.stringify(after));

// ---------------- Refusals ----------------
await H.page.evaluate(() => window.__jltg.received.openPasteSheet());
await H.page.waitForSelector('.sheet.open #rq-text');
await H.page.fill('.sheet.open #rq-text', areaMsg);
await H.page.click('.sheet.open #rq-go');
await H.page.waitForTimeout(150);
check('hider: a play area pasted into 📥 is redirected to Zones', /Zones ▸ ⇩ Import area/.test(await H.page.locator('.sheet.open #rq-status').innerText()));
await H.page.fill('.sheet.open #rq-text', coastMsg.slice(0, coastMsg.length - 30));
await H.page.click('.sheet.open #rq-go');
await H.page.waitForTimeout(150);
check('hider: a truncated message is refused', /cut off or edited/.test(await H.page.locator('.sheet.open #rq-status').innerText()));
// Re-pasting the SAME message replaces it rather than stacking a duplicate.
await H.page.fill('.sheet.open #rq-text', coastMsg);
await H.page.click('.sheet.open #rq-go');
await H.page.waitForSelector('.sheet.open #rv-remove');
check('hider: re-pasting the same message does not duplicate it', await H.page.evaluate(() => window.__jltg.received.list().length) === 2);
await H.page.click('.sheet.open #rv-remove');
await H.page.waitForTimeout(200);
check('hider: 🗑 Remove deletes it', await H.page.evaluate(() => window.__jltg.received.list().map((e) => e.ref.title).join('|')) === 'Matching · Museum');

check('no page errors on either phone', S.errs.length + H.errs.length === 0, [...S.errs, ...H.errs].join(' | '));
const ok = done();
await browser.close();
process.exit(ok ? 0 : 1);
