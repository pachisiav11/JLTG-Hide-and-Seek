// Boot the real app in a Playwright browser context with Google Maps STUBBED — one context per
// "phone", so IndexedDB, localStorage and the clipboard are isolated exactly as on two devices.
//
// The stub is the same proxy the other *-e2e.mjs files inline: every google.maps constructor
// returns an inert object, so the app's own code (sheets, store, geometry, wire formats) runs
// for real while nothing tries to reach Google. That makes these suites a test of THIS app's
// code, not of the Maps key or the network.
//
// BASE_URL selects what is served (default: a local `npx http-server -p 8899 -s .`).
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

export const BASE = process.env.BASE_URL || 'http://127.0.0.1:8899/';

export async function launch() {
  return chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
}

export async function phone(browser, label, { viewport = { width: 420, height: 900 } } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`${label}: ${e.message}`));
  await page.addInitScript(() => {
    const h = { get(t,p){ if(p==='then')return undefined; if(!(p in t)) t[p]=new Proxy(function(){return new Proxy({},h)},h); return t[p]; }, apply(){return new Proxy({},h)}, construct(){return new Proxy({},h)} };
    const maps = new Proxy(function(){}, h);
    maps.event = { addListener: () => ({remove(){}}), removeListener(){}, clearInstanceListeners(){}, trigger(){} };
    maps.SymbolPath = { CIRCLE: 0 };
    maps.LatLngBounds = function(){ return { extend(){}, isEmpty: () => true, getCenter: () => ({lat:()=>19,lng:()=>72}) }; };
    maps.Map = function(){ return new Proxy({ addListener: () => ({remove(){}}), setCenter(){}, fitBounds(){}, panTo(){}, getCenter: () => ({lat:()=>19.07,lng:()=>72.87}), setOptions(){}, controls: [] }, h); };
    window.google = { maps };
    window.JLTG_CONFIG = { GOOGLE_MAPS_API_KEY: 'stub', OVERPASS_PROXY_URL: '', MULTIPLAYER_URL: '' };
    // No GPS in a headless context: answer immediately rather than leave flows waiting 8 s.
    try {
      Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
        watchPosition: (_ok, err) => { setTimeout(() => err?.({ code: 2, message: 'no fix (e2e)' }), 10); return 1; },
        clearWatch() {}, getCurrentPosition: (_ok, err) => setTimeout(() => err?.({ code: 2, message: 'no fix (e2e)' }), 10),
      } });
    } catch {}
  });
  const origin = new URL(BASE).origin;
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(origin) && !/\/config\.js(\?|$)/.test(u)) return r.continue();
    return r.fulfill({ status: 204, body: '' });
  });
  await page.goto(new URL('index.html', BASE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__jltg, { timeout: 30000 });
  await page.waitForTimeout(1200);
  return { page, errs, ctx };
}

export function checker() {
  const results = [];
  const check = (n, ok, d = '') => { results.push(!!ok); console.log(`${ok ? '  ok  ' : ' FAIL '} ${n}${d ? ` — ${d}` : ''}`); };
  const done = () => { console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`); return results.every(Boolean); };
  return { check, done };
}

export const openSheetText = (page) => page.locator('.sheet.open').innerText();
export const toastText = (page) => page.evaluate(() => document.getElementById('toast')?.textContent || '');
export const BOARD = [[19.00, 72.80], [19.00, 72.98], [19.16, 72.98], [19.16, 72.80]];
