// Parser tests for A2 seeker-location ingest. Runs pure — no DOM, no store — so
// every accepted paste shape and every guarded refusal is a single-line assertion.
import test from "node:test";
import assert from "node:assert/strict";
import { parseSeekerLocation } from "../src/ingest.js";

test("bare 'lat, lng' — the WhatsApp long-press-copy fallback", () => {
  const out = parseSeekerLocation("19.15, 72.85");
  assert.deepEqual(out, { lat: 19.15, lng: 72.85, source: "pair" });
});

test("space-separated pair", () => {
  const out = parseSeekerLocation("19.15 72.85");
  assert.deepEqual(out, { lat: 19.15, lng: 72.85, source: "pair" });
});

test("negative coordinates (southern hemisphere / western hemisphere)", () => {
  const out = parseSeekerLocation("-33.8688, 151.2093");
  assert.equal(out.lat, -33.8688);
  assert.equal(out.lng, 151.2093);
});

test("Google Maps place URL with @lat,lng,zoom", () => {
  const out = parseSeekerLocation("https://www.google.com/maps/place/Devipada/@19.24,72.87,15z/data=abc");
  assert.deepEqual(out, { lat: 19.24, lng: 72.87, source: "gmaps-at" });
});

test("Google Maps ?q= URL — the /maps?q= form and share URLs", () => {
  const out = parseSeekerLocation("https://maps.google.com/maps?q=19.15,72.85");
  assert.deepEqual(out, { lat: 19.15, lng: 72.85, source: "gmaps-q" });
});

test("URL wins over any trailing pair that happens to look like coordinates", () => {
  // A common WhatsApp message: "https://maps.app.goo.gl/... someone at 12.5 45.7 gmt".
  // We can't resolve the short URL, so we must NOT then match the "12.5 45.7"
  // that came after it. Order-of-preference here matters.
  const out = parseSeekerLocation("check out https://www.google.com/maps/place/@19.24,72.87,15z later at 12.5 45.7 tonight");
  assert.equal(out.source, "gmaps-at");
  assert.equal(out.lat, 19.24);
});

test("URL-form parse checks the URL's own coordinates, not stray digits", () => {
  const out = parseSeekerLocation("https://maps.google.com/maps?q=19.15,72.85&zoom=18");
  assert.deepEqual(out, { lat: 19.15, lng: 72.85, source: "gmaps-q" });
});

test("integer-only pair is refused — 19 72 could be anything", () => {
  // A single-digit pair without a decimal is not a plausible WhatsApp share; a
  // silent-accept here would eliminate real ground somewhere in the Arabian Sea.
  assert.equal(parseSeekerLocation("19 72"), null);
});

test("out-of-range values are refused, not clamped", () => {
  assert.equal(parseSeekerLocation("91.0, 0.0"), null, "lat > 90");
  assert.equal(parseSeekerLocation("0.0, 181.0"), null, "lng > 180");
});

test("empty string / non-string / random text — null, no throw", () => {
  assert.equal(parseSeekerLocation(""), null);
  assert.equal(parseSeekerLocation("   "), null);
  assert.equal(parseSeekerLocation(null), null);
  assert.equal(parseSeekerLocation(undefined), null);
  assert.equal(parseSeekerLocation(42), null);
  assert.equal(parseSeekerLocation("meet at central station"), null);
});

test("a pair prefixed by 'lat=' or similar still parses — real WhatsApp messages", () => {
  const out = parseSeekerLocation("Live location: 19.15, 72.85 (accuracy ~10 m)");
  assert.equal(out.lat, 19.15);
});
