// Share a whole game in a URL (v2 Phase 6, item U).
//
// For a game where players hand a phone around or coordinate over chat, this is the highest
// value-per-line feature in the reference mapper: no accounts, no backend, no upload — the
// board, its questions and its answers travel in the link itself.
//
// DELIBERATELY NOT COPIED: the reference's overflow path. When its URL exceeds ~2,000
// characters it POSTs the game to Pastebin through `cors-anywhere.com`, which sends the
// user's Pastebin API key and their entire game state through a third-party CORS proxy of
// unclear provenance (MAPPER_ANALYSIS §7.7, §10.7). We already have a JSON file export that
// solves the same problem with no third party at all, so an oversized board falls back to
// that instead. A share feature must never be the reason data leaves the device by a route
// the player did not choose.
//
// Wire format:  <base>?g=<base64url(deflate(json))>
//
// `deflate` rather than `gzip`: same algorithm, ~18 bytes less header, and every byte counts
// against a URL limit. Base64url (`-`/`_`, no padding) because `+`, `/` and `=` all need
// escaping in a query string, which would inflate the payload it just compressed.

export const SHARE_PARAM = "g";

// Practical URL ceiling. The real limits are ~2,000 chars in older IE, ~8,000 in most
// servers, ~64k in Chrome — but the binding constraint is neither: it is chat apps and QR
// codes, which mangle or refuse long links well before browsers do. 8,000 is the value that
// keeps a link paste-able in practice while comfortably fitting a normal board.
export const MAX_URL_LENGTH = 8000;

function assertStreams() {
  if (typeof CompressionStream === "undefined" || typeof DecompressionStream === "undefined") {
    throw new Error("This browser can't compress share links (CompressionStream unavailable). Use Export instead.");
  }
}

const toBase64Url = (bytes) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa exists in browsers and in Node ≥16.
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (s) => {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function streamThrough(bytes, stream) {
  const writer = stream.writable.getWriter();
  // When the payload is corrupt the DECOMPRESSION side errors the whole stream, which rejects
  // BOTH the read below and these writer promises. Only the read is awaited, so an unhandled
  // `writer.write()` rejection escapes the caller's try/catch entirely and surfaces as an
  // `unhandledRejection` — in a browser that is a console error the user cannot act on, and
  // under `node --test` it fails the file even though every assertion passed.
  //
  // The write failure is never independently interesting: it is the same error the read is
  // about to report, with a worse message. Absorb it here and let the read be the one voice.
  const swallow = () => {};
  writer.write(bytes).catch(swallow);
  writer.close().catch(swallow);
  const buf = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buf);
}

/** Compress a string to a base64url token. */
export async function compressToToken(str) {
  assertStreams();
  const bytes = new TextEncoder().encode(String(str));
  return toBase64Url(await streamThrough(bytes, new CompressionStream("deflate")));
}

/** Inverse of compressToToken. Throws on anything that is not a token we wrote. */
export async function decompressFromToken(token) {
  assertStreams();
  if (!token || typeof token !== "string") throw new Error("This link carries no game data.");
  let bytes;
  try { bytes = fromBase64Url(token); }
  catch { throw new Error("This share link is damaged (bad encoding) — ask for it again."); }
  let out;
  try { out = await streamThrough(bytes, new DecompressionStream("deflate")); }
  catch { throw new Error("This share link is damaged (bad payload) — ask for it again."); }
  return new TextDecoder().decode(out);
}

/**
 * Strip a game down to what a share link needs to carry.
 *
 * Deliberately omits two things:
 *   - `notes`, which routinely contain private context ("hider's sister lives here"). A share
 *     link is handed to the other team as often as to a teammate, and a note leaking is not
 *     recoverable. Exporting the JSON file still carries them; that is a deliberate,
 *     file-shaped action rather than a pasted link.
 *   - `redoStack`, which is per-device UI state and means nothing on another phone.
 *
 * The station list IS carried, which reverses an earlier decision. It used to be omitted as
 * "hundreds of entries, re-sourceable from the board", with only the ELIMINATIONS sent as
 * `stationEliminations` — a field nothing ever read back, so a seeker's station calls
 * silently did not travel. Both halves of that reasoning are now wrong: the list is a
 * hand-tapped shortlist of a few points rather than a sourced set, and hand-placed ids
 * (`manual:…`) cannot be re-derived on another device by any means. Small enough to send,
 * and impossible to reconstruct if it is not.
 */
export function toSharePayload(game) {
  if (!game) throw new Error("There is no game to share.");
  return {
    v: 1,
    name: game.name,
    zones: game.zones || [],
    focusZone: game.focusZone || null,
    history: game.history || [],
    railFilter: game.railFilter || null,
    settings: game.settings || null,
    // The whole shortlist, eliminations included — see above.
    stations: game.stations?.list || [],
  };
}

/** Build the share URL. Returns { url, tooLong, length }. */
export async function buildShareUrl(game, baseUrl) {
  const token = await compressToToken(JSON.stringify(toSharePayload(game)));
  const base = String(baseUrl || "").split("#")[0].split("?")[0];
  const url = `${base}?${SHARE_PARAM}=${token}`;
  return { url, tooLong: url.length > MAX_URL_LENGTH, length: url.length };
}

/** Read a share token out of a URL (or a bare query string). Returns null when absent. */
export function tokenFromUrl(href) {
  const s = String(href || "");
  const q = s.indexOf("?");
  if (q < 0) return null;
  const params = new URLSearchParams(s.slice(q + 1).split("#")[0]);
  return params.get(SHARE_PARAM);
}

/**
 * Parse a share token back into a payload.
 *
 * Validated rather than trusted: a share link is UNTRUSTED INPUT — it arrives from another
 * device via a chat app, and may be truncated, edited, or from a future version. Anything
 * malformed must produce a clear message, never a half-loaded board, because a board that
 * loads with some questions missing is worse than one that refuses: the seeker cannot see
 * what is absent.
 */
export async function parseShareToken(token) {
  const json = await decompressFromToken(token);
  let payload;
  try { payload = JSON.parse(json); }
  catch { throw new Error("This share link is damaged (not readable) — ask for it again."); }

  if (!payload || typeof payload !== "object") throw new Error("This share link doesn't contain a game.");
  if (payload.v !== 1) throw new Error(`This link was made by a different version of the app (format ${payload.v}). Ask for a JSON export instead.`);
  if (!Array.isArray(payload.zones)) throw new Error("This share link is missing its play area.");
  if (!Array.isArray(payload.history)) throw new Error("This share link is missing its questions.");
  return payload;
}
