// v2 Phase 6, item U — a whole game in a URL.
//
// For a game where players hand a phone around or coordinate over chat this is the highest
// value-per-line feature in the reference mapper: no accounts, no backend, no upload.
//
// Two things get as much test attention as the happy path, because both are where this kind
// of feature goes wrong:
//
//   1. A share link is UNTRUSTED INPUT. It arrives from another device through a chat app
//      that may have truncated it, and it may come from a different app version. Anything
//      malformed must refuse with a clear message rather than half-load a board — a board
//      that loads with some questions silently missing is worse than one that refuses,
//      because the seeker cannot see what is absent.
//   2. What the payload DOESN'T carry. Notes routinely contain private context and a share
//      link is handed to the other team as often as to a teammate.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compressToToken, decompressFromToken, toSharePayload, buildShareUrl,
  tokenFromUrl, parseShareToken, SHARE_PARAM, MAX_URL_LENGTH,
} from "../src/share-link.js";

const game = (over = {}) => ({
  id: "game_1",
  name: "Mumbai Saturday",
  zones: [{ id: "z1", name: "Board", polygon: [[19.0, 72.8], [19.1, 72.8], [19.1, 72.9], [19.0, 72.9]] }],
  focusZone: { point: { lat: 19.05, lng: 72.85 }, radius: 800 },
  history: [
    { id: "s1", tool: "radar", enabled: true, inputs: { center: { lat: 19.05, lng: 72.85 }, radius: 4000 }, answer: { side: "in" } },
  ],
  railFilter: { hiddenRoutes: ["tram"], hiddenLines: [] },
  settings: { units: "metric", hidingRadiusM: 800 },
  notes: [{ id: "n1", point: { lat: 19.02, lng: 72.81 }, text: "hider's sister lives on this street", at: 1 }],
  redoStack: ["s9"],
  stations: { list: [
    { id: "osm:node/1", name: "A", lat: 19.01, lng: 72.81 },
    { id: "osm:node/2", name: "B", lat: 19.02, lng: 72.82, eliminated: true, eliminatedBy: "manual" },
  ] },
  ...over,
});

// ---- Round trip ---------------------------------------------------------

test("a string survives compression and decompression intact", async () => {
  const s = JSON.stringify({ hello: "world", unicode: "Kurla — Ghatkopar ✅", n: 12345.6789 });
  assert.equal(await decompressFromToken(await compressToToken(s)), s);
});

test("the token is URL-safe: no +, / or = to escape", async () => {
  // A token needing percent-encoding would inflate exactly the payload it just compressed.
  const token = await compressToToken(JSON.stringify(game()));
  assert.doesNotMatch(token, /[+/=]/);
  assert.equal(encodeURIComponent(token), token, "the token must survive a query string untouched");
});

test("a game round-trips through a URL", async () => {
  const g = game();
  const { url } = await buildShareUrl(g, "https://example.test/app/");
  const payload = await parseShareToken(tokenFromUrl(url));

  assert.equal(payload.name, g.name);
  assert.equal(payload.zones.length, 1);
  assert.equal(payload.history.length, 1);
  assert.equal(payload.history[0].answer.side, "in");
  assert.deepEqual(payload.railFilter, g.railFilter);
  assert.equal(payload.settings.hidingRadiusM, 800);
});

test("compression genuinely shrinks a real board", async () => {
  const g = game();
  const raw = JSON.stringify(toSharePayload(g)).length;
  const token = await compressToToken(JSON.stringify(toSharePayload(g)));
  assert.ok(token.length < raw, `token ${token.length} must be smaller than raw ${raw}`);
});

test("a realistic 12-question board still fits in a link", async () => {
  const many = game({
    history: Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`, tool: "radar", enabled: true,
      inputs: { center: { lat: 19.05 + i * 0.001, lng: 72.85 }, radius: 3000 + i },
      answer: { side: i % 2 ? "in" : "out" },
    })),
  });
  const { url, tooLong, length } = await buildShareUrl(many, "https://example.test/app/");
  assert.equal(tooLong, false, `a normal board must fit: ${length} chars`);
  assert.ok(length < MAX_URL_LENGTH);
});

// ---- What the payload deliberately omits --------------------------------

test("notes are NOT shared — a link goes to the other team as often as to a teammate", () => {
  const p = toSharePayload(game());
  assert.equal(p.notes, undefined);
  assert.doesNotMatch(JSON.stringify(p), /sister/, "no note text may survive into the link");
});

test("the station shortlist travels in full, eliminations included", () => {
  // Reversed from the original design, which sent only `stationEliminations` on the grounds
  // that the list was hundreds of re-sourceable entries. Both halves stopped being true: the
  // list is now a hand-tapped shortlist of a few points, and a hand-placed `manual:` id
  // cannot be re-derived on another device by any means. (The old field was also never read
  // back on load, so those eliminations silently did not travel at all.)
  const p = toSharePayload(game());
  assert.equal(p.stationEliminations, undefined, "the write-only field is gone");
  assert.equal(p.stations.length, 2, "the whole shortlist travels");
  assert.deepEqual(p.stations.map((s) => s.id), ["osm:node/1", "osm:node/2"]);
  const b = p.stations.find((s) => s.id === "osm:node/2");
  assert.equal(b.eliminated, true, "and each entry keeps its elimination");
  assert.equal(b.eliminatedBy, "manual");
});

test("a hand-tapped shortlist survives the full round trip to another device", async () => {
  // The property that matters: what the sender sees is what the receiver gets. Manual ids
  // are random, so this fails the moment anything tries to re-derive them.
  const tapped = game({ stations: { list: [
    { id: "manual:m1x:ab12cd", name: "Station 1", lat: 19.03, lng: 72.83, kind: "manual" },
    { id: "manual:m1x:ef34gh", name: "Station 2", lat: 19.04, lng: 72.84, kind: "manual", eliminated: true, eliminatedBy: "manual" },
  ] } });
  const token = await compressToToken(JSON.stringify(toSharePayload(tapped)));
  const back = await parseShareToken(token);
  assert.deepEqual(back.stations, tapped.stations.list);
});

test("redoStack is dropped — it is per-device UI state", () => {
  assert.equal(toSharePayload(game()).redoStack, undefined);
});

test("a shortlist-sized station list stays comfortably inside the URL budget", async () => {
  // Carrying the list is only affordable because it is a shortlist now. Pin the size that
  // actually ships: a seeker with 25 candidates left is already an unusually crowded endgame.
  const shortlist = game({
    stations: { list: Array.from({ length: 25 }, (_, i) => ({
      id: `manual:m${i}:zzzzzz`, name: `Station number ${i}`, lat: 19 + i * 1e-4, lng: 72.8 + i * 1e-4,
    })) },
  });
  const { tooLong, length } = await buildShareUrl(shortlist, "https://example.test/app/");
  assert.equal(tooLong, false, `25 stations must not push the link over the limit (was ${length})`);
});

// ---- Untrusted input ----------------------------------------------------

test("a truncated token refuses with a clear message", async () => {
  const token = await compressToToken(JSON.stringify(toSharePayload(game())));
  await assert.rejects(parseShareToken(token.slice(0, Math.floor(token.length / 2))), /damaged/i);
});

test("junk in the parameter refuses rather than half-loading", async () => {
  for (const junk of ["", "!!!!", "not-a-token", "%%%%"]) {
    await assert.rejects(parseShareToken(junk), /(damaged|carries no game data)/i);
  }
});

test("a token that decompresses but is not JSON refuses", async () => {
  await assert.rejects(parseShareToken(await compressToToken("this is not json")), /damaged/i);
});

test("a future format version is refused by name, not silently mis-read", async () => {
  const token = await compressToToken(JSON.stringify({ v: 99, zones: [], history: [] }));
  await assert.rejects(parseShareToken(token), /different version/i);
});

test("a payload missing its board or its questions refuses", async () => {
  await assert.rejects(parseShareToken(await compressToToken(JSON.stringify({ v: 1, history: [] }))), /play area/i);
  await assert.rejects(parseShareToken(await compressToToken(JSON.stringify({ v: 1, zones: [] }))), /questions/i);
});

// ---- URL handling -------------------------------------------------------

test("tokenFromUrl finds the parameter and ignores everything else", () => {
  assert.equal(tokenFromUrl("https://x.test/a?g=ABC"), "ABC");
  assert.equal(tokenFromUrl("https://x.test/a?other=1&g=ABC&z=2"), "ABC");
  assert.equal(tokenFromUrl("https://x.test/a?g=ABC#hash"), "ABC");
  assert.equal(tokenFromUrl("https://x.test/a"), null);
  assert.equal(tokenFromUrl(""), null);
});

test("building a share URL strips any existing query or hash", async () => {
  const { url } = await buildShareUrl(game(), "https://x.test/app/?g=STALE#section");
  assert.equal(url.startsWith("https://x.test/app/?" + SHARE_PARAM + "="), true);
  assert.equal((url.match(/\?/g) || []).length, 1, "no stale query may survive");
  assert.equal(url.includes("#"), false);
});

test("an oversized board is reported, not silently truncated or uploaded", async () => {
  // The reference mapper POSTs overflow to Pastebin through a third-party CORS proxy. We
  // report it and let the caller fall back to the existing JSON file export, so a share
  // action can never be the reason data leaves the device by a route nobody chose.
  const huge = game({
    history: Array.from({ length: 400 }, (_, i) => ({
      id: `s${i}`, tool: "matching", enabled: true,
      inputs: { mode: "nearest", features: Array.from({ length: 30 }, (_, j) => ({ name: `Place ${i}-${j}`, lat: 19 + j * 1e-3, lng: 72.8 + j * 1e-3 })) },
      answer: { featureIndex: 0, keep: true },
    })),
  });
  const { tooLong, url } = await buildShareUrl(huge, "https://x.test/app/");
  assert.equal(tooLong, true);
  assert.ok(url.length > MAX_URL_LENGTH, "the caller gets the real length to decide with");
});

test("sharing nothing is an error, not an empty link", async () => {
  await assert.rejects(async () => buildShareUrl(null, "https://x.test/"), /no game to share/i);
});
