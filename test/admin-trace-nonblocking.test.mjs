// P1: `_adminTracePrompt` awaited `_divisionDefinitionNote` before calling `openSheet`, so the
// trace sheet rendered nothing until 25 /overpass/divisions grid probes had settled — measured
// at 37,769 ms on a cold Mumbai board (5 ms once warm). A Hide & Seek round has a clock; the
// player saw no sheet, no spinner and no toast for half a minute, and a second tap started a
// second sweep.
//
// The note is advisory: nothing in the sheet depends on it, and `_divisionDefinitionNote`
// already returns "" on failure, so an empty slot is a state the markup handles. The fix is an
// ordering property — start the probes, render, inject on arrival.
//
// Asserting that ordering properly would need a DOM and a Maps instance. What is asserted here
// is the source invariant that carries it, in the style of shell-assets/schema-doc: the note
// must not be awaited on the path to openSheet, and there must be a slot for it to land in.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/layers.js", import.meta.url), "utf8");

// The body of _adminTracePrompt, up to the next method at the same indent.
function adminTracePromptBody() {
  const start = SRC.indexOf("async _adminTracePrompt(card) {");
  assert.ok(start > 0, "_adminTracePrompt not found — this test is pinned to the wrong symbol");
  const end = SRC.indexOf("\n  // ---- Tentacles", start);
  assert.ok(end > start, "could not find the end of _adminTracePrompt");
  return SRC.slice(start, end);
}

test("_adminTracePrompt never awaits the division note", () => {
  const body = adminTracePromptBody();
  assert.ok(
    !/await\s+this\._divisionDefinitionNote/.test(body),
    "awaiting the note here is the 37.8 s stall — start it and inject it instead",
  );
});

test("the note is started before the sheet opens, not after", () => {
  // Kicking it off after openSheet would still render promptly but would delay the probes by a
  // frame for no reason; more importantly it would mean the promise is not in scope to inject.
  const body = adminTracePromptBody();
  const kick = body.indexOf("_divisionDefinitionNote(card)");
  const open = body.indexOf("openSheet(");
  assert.ok(kick > 0, "the note is no longer requested at all");
  assert.ok(open > 0, "openSheet is no longer called");
  assert.ok(kick < open, "the probes must be in flight while the sheet renders");
});

test("a probe failure cannot reject into an unhandled promise", () => {
  // Un-awaited now, so a rejection has no caller to surface it. `_divisionDefinitionNote`
  // catches internally today, but that is its business, not this call site's guarantee.
  const body = adminTracePromptBody();
  assert.match(
    body,
    /_divisionDefinitionNote\(card\)\.catch\(/,
    "the detached promise needs its own catch",
  );
});

test("the sheet renders a slot the note can be injected into", () => {
  const body = adminTracePromptBody();
  assert.match(body, /id="at-note"/, "no slot for the note to land in");
  assert.match(body, /notePromise\.then\(/, "nothing ever fills the slot");
});

test("the injection is skipped once the sheet has closed", () => {
  // The player can skip or start drawing well before 38 s of probes finish; writing into a
  // closed sheet would either throw or resurrect markup.
  const body = adminTracePromptBody();
  const then = body.indexOf("notePromise.then(");
  const guard = body.indexOf("settled", then);
  assert.ok(guard > then && guard - then < 200, "the injection must bail out when settled");
});
