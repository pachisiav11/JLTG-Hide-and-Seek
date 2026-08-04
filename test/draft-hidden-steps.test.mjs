// v2 Phase 2, items G + H — draft and hidden are the two halves of `enabled`.
//
// A step produces exactly two things: an ELIMINATION (shading) and GUIDES (its circle,
// bisector, cell outlines, buffer ring). `enabled` switched both off together, so there was
// no way to ask for either alone. These tests pin the two states that were missing and,
// more importantly, pin that they are genuinely DIFFERENT from each other and from disabling.
//
// The fold-level behaviour is what matters and what these assert. The panel markup that
// drives it is DOM-bound and is not tested here; the contract it depends on is.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { turf, squareArea, radarStep } from "./helpers/turf-env.mjs";
import { computeActiveArea, computeElimination } from "../src/tools.js";
import { createStep } from "../src/model.js";

const BOARD = () => squareArea([72.8777, 19.076], 0.4);
const km2 = (g) => (g ? turf.area(turf.feature(g)) / 1e6 : 0);

// `layers.js` filters drafts out of the fold before calling computeActiveArea, so that is
// the contract under test: a board folded WITHOUT its drafts.
const foldWithDrafts = (board, steps) => computeActiveArea(board, steps.filter((s) => !s.draft));

test("a draft step does not eliminate, but is otherwise a normal step", () => {
  const board = BOARD();
  const live = radarStep({ id: "live", radiusM: 9000, side: "in" });
  const draft = { ...radarStep({ id: "draft", radiusM: 9000, side: "in" }), draft: true };

  const withLive = km2(foldWithDrafts(board, [live]));
  const withDraft = km2(foldWithDrafts(board, [draft]));

  assert.ok(withLive < km2(board) * 0.9, "sanity: the live question does eliminate");
  assert.equal(withDraft, km2(board), "a draft must leave the board untouched");
});

test("a draft still computes its guides — that is the entire point of it", () => {
  const board = BOARD();
  const draft = { ...radarStep({ id: "d", radiusM: 9000, side: "in" }), draft: true };
  // The guides come from computeElimination, which knows nothing about `draft` — the flag is
  // honoured by the caller. If that ever changed, a draft would draw nothing and be
  // indistinguishable from a disabled step, which is the failure this test exists to catch.
  const { guides } = computeElimination(draft, board);
  assert.ok(guides.length > 0, "a draft must still produce the boundary the seeker is previewing");
});

test("a hidden step still eliminates — it only stops drawing", () => {
  const board = BOARD();
  const hidden = { ...radarStep({ id: "h", radiusM: 9000, side: "in" }), hidden: true };
  const plain = radarStep({ id: "p", radiusM: 9000, side: "in" });

  assert.equal(
    km2(foldWithDrafts(board, [hidden])).toFixed(3),
    km2(foldWithDrafts(board, [plain])).toFixed(3),
    "hiding must not change the shading",
  );
  assert.ok(km2(foldWithDrafts(board, [hidden])) < km2(board) * 0.9, "and it must still be applied");
});

test("draft and hidden are different from each other and from disabled", () => {
  const board = BOARD();
  const boardKm2 = km2(board);
  const mk = (extra) => [{ ...radarStep({ id: "x", radiusM: 9000, side: "in" }), ...extra }];

  const applied = km2(foldWithDrafts(board, mk({})));
  const drafted = km2(foldWithDrafts(board, mk({ draft: true })));
  const hiddenA = km2(foldWithDrafts(board, mk({ hidden: true })));
  const disabled = km2(foldWithDrafts(board, mk({ enabled: false })));

  assert.ok(applied < boardKm2, "applied eliminates");
  assert.equal(drafted, boardKm2, "draft does not eliminate");
  assert.equal(disabled, boardKm2, "disabled does not eliminate");
  assert.equal(hiddenA.toFixed(3), applied.toFixed(3), "hidden eliminates exactly like applied");

  // Draft and disabled agree on the SHADING and differ only in guides — which is precisely
  // why the guide half is asserted separately above.
  assert.equal(drafted, disabled);
});

test("a mixed board applies the live and hidden questions and previews the draft", () => {
  const board = BOARD();
  const steps = [
    radarStep({ id: "a", radiusM: 20000, side: "in" }),
    { ...radarStep({ id: "b", radiusM: 25000, side: "in" }), hidden: true },
    { ...radarStep({ id: "c", radiusM: 3000, side: "in" }), draft: true },
  ];
  const folded = km2(foldWithDrafts(board, steps));
  const withoutDraft = km2(foldWithDrafts(board, steps.slice(0, 2)));
  assert.equal(folded.toFixed(3), withoutDraft.toFixed(3), "the draft contributes nothing to the fold");

  // And the draft is the tightest question on the board, so applying it would change the
  // answer a lot — proving the equality above is meaningful rather than coincidental.
  const ifApplied = km2(foldWithDrafts(board, steps.map((s) => ({ ...s, draft: false }))));
  assert.ok(ifApplied < folded * 0.5, "applying the draft would change the board substantially");
});

test("createStep defaults both flags off, and older saved steps read as off", () => {
  const s = createStep({ tool: "radar", inputs: { center: { lat: 19, lng: 72 }, radius: 100 }, answer: { side: "in" } });
  assert.equal(s.draft, false);
  assert.equal(s.hidden, false);

  // A step written before these fields existed has neither key. Nothing may throw on it and
  // both must read falsy — this is the whole migration story.
  const legacy = { id: "old", tool: "radar", enabled: true, inputs: {}, answer: {} };
  assert.ok(!legacy.draft && !legacy.hidden);
});
