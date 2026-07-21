// Phase 38 (Stage 4): the in-app Guide renders its sections.
//
// The Guide is a scaffold covering the features that outgrew the original
// "How to play" sheet — stations, live-share, alerts — plus an Android section
// that Phase 45 turns into a real permissions wizard. Content is data, so this
// checks the sections and the assembled sheet body without a DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { guideSections, guideBodyHTML } from "../src/guide.js";

test("guide 1: the expected feature sections are present", () => {
  const ids = guideSections().map((s) => s.id);
  for (const id of ["questions", "stations", "live-share", "alerts", "android"]) {
    assert.ok(ids.includes(id), `Guide must have a "${id}" section`);
  }
});

test("guide 2: every section has a title and non-empty body", () => {
  for (const s of guideSections()) {
    assert.ok(s.title && s.title.trim().length, `${s.id} needs a title`);
    assert.ok(s.html && s.html.trim().length > 20, `${s.id} needs real content`);
  }
});

test("guide 3: the sheet body renders one section per entry, in order, with a close button", () => {
  const html = guideBodyHTML();
  for (const s of guideSections()) {
    assert.ok(html.includes(`id="guide-${s.id}"`), `sheet must render a <section> for ${s.id}`);
    assert.ok(html.includes(s.title), `sheet must show the ${s.id} title`);
  }
  assert.ok(html.includes('id="guide-close"'), "the sheet has a close button games.js wires");
  // Order preserved.
  const positions = guideSections().map((s) => html.indexOf(`id="guide-${s.id}"`));
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, sorted, "sections render in declaration order");
});

test("guide 4: the Android section is the Phase-45 scaffold — honest about the web caveat", () => {
  const android = guideSections().find((s) => s.id === "android");
  assert.match(android.html, /Android app/i, "points at the native track");
  assert.match(android.html, /all the time|battery/i, "names the permissions the wizard will handle");
});
