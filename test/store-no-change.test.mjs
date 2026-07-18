// P5 and P6.
//
// P5: `features._mapClaimed` was a boolean, so a nested flow releasing the map click handed
// taps back to measure mode while the OUTER flow was still drawing — the exact bug the claim
// was added to prevent, reappearing only when nested and therefore very hard to attribute. No
// path nests today; a depth counter removes the need to keep proving that.
//
// P6: `store.update` ran `scheduleSave()` and `emit()` unconditionally, so a mutator that
// decided mid-flight to change nothing (a zone whose union fails is pushed and popped again)
// still cost a full game write and a full re-render.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---- P5: the claim depth counter -------------------------------------------------
//
// Modelled rather than driven through MapFeatures, which needs a live google.maps. The
// listeners are three lines; what matters is the arithmetic they implement, so the arithmetic
// is what is asserted, against the source that implements it.

function makeClaims() {
  // The exact bodies of the two listeners in features.js init().
  let claims = 0;
  return {
    claim: () => { claims++; },
    release: () => { claims = Math.max(0, claims - 1); },
    get claimed() { return claims > 0; },
    get depth() { return claims; },
  };
}

test("a single claim/release round-trips, as the boolean did", () => {
  const c = makeClaims();
  assert.equal(c.claimed, false);
  c.claim();
  assert.equal(c.claimed, true);
  c.release();
  assert.equal(c.claimed, false, "measure mode must get its taps back");
});

test("a nested flow releasing does NOT hand taps back to measure mode", () => {
  // This is the whole finding. Flow A claims; flow B claims and releases; A is still drawing.
  const c = makeClaims();
  c.claim();          // flow A begins
  c.claim();          // flow B begins
  c.release();        // flow B ends
  assert.equal(c.claimed, true, "flow A is still drawing — measure must stay locked out");
  c.release();        // flow A ends
  assert.equal(c.claimed, false);
});

test("an unmatched release cannot drive the count negative", () => {
  // A flow that releases twice would otherwise leave the count at -1, and the NEXT real claim
  // would only bring it to 0 — measure mode would eat that flow's taps with nothing to show why.
  const c = makeClaims();
  c.claim();
  c.release();
  c.release();        // unmatched
  assert.equal(c.depth, 0, "clamped, not negative");
  c.claim();
  assert.equal(c.claimed, true, "the next flow must still be able to claim");
});

test("features.js implements exactly that arithmetic", () => {
  const src = readFileSync(new URL("../src/features.js", import.meta.url), "utf8");
  assert.ok(!/_mapClaimed/.test(src), "the boolean must be gone, not shadowed");
  assert.match(src, /this\._claims\+\+/, "claim must increment");
  assert.match(src, /this\._claims\s*=\s*Math\.max\(0,\s*this\._claims\s*-\s*1\)/, "release must clamp at zero");
  assert.match(src, /if \(this\._claims > 0\) return;/, "the tap guard must read the depth");
});

// ---- P6: update() skips the save and the render when nothing changed --------------

// A stand-in for the module's `current` + listeners, implementing update()'s contract.
function makeStore() {
  const state = { saves: 0, emits: 0, current: { zones: [] } };
  const update = (mutator) => {
    if (!state.current) return;
    const changed = mutator(state.current);
    if (changed === false) return;
    state.saves++;
    state.emits++;
  };
  return { state, update };
}

test("a mutator returning false costs neither a write nor a render", () => {
  const { state, update } = makeStore();
  update((g) => { g.zones.push("a"); g.zones.pop(); return false; });
  assert.equal(state.saves, 0, "a refused zone left the record identical — nothing to write");
  assert.equal(state.emits, 0, "and nothing to re-render");
});

test("a normal mutator still saves and emits", () => {
  const { state, update } = makeStore();
  update((g) => { g.zones.push("a"); });
  assert.equal(state.saves, 1);
  assert.equal(state.emits, 1);
});

test("only exactly `false` skips — falsy returns must still persist", () => {
  // The trap this guards: a mutator whose last expression is 0, "" or null would otherwise
  // stop persisting a change it really made.
  for (const v of [0, "", null, undefined, NaN]) {
    const { state, update } = makeStore();
    update((g) => { g.zones.push("a"); return v; });
    assert.equal(state.saves, 1, `returning ${String(v)} must not be read as "no change"`);
  }
});

test("store.js implements that contract", () => {
  const src = readFileSync(new URL("../src/store.js", import.meta.url), "utf8");
  assert.match(src, /const changed = mutator\(current\);/, "the return value must be captured");
  assert.match(src, /if \(changed === false\) return;/, "and tested identically, not loosely");
});

test("both zone paths that change nothing report it", () => {
  const src = readFileSync(new URL("../src/zones.js", import.meta.url), "utf8");
  // addZone: pushes, discovers the union failed, pops.
  const add = src.slice(src.indexOf("async addZone("), src.indexOf("removeZone(id)"));
  assert.match(add, /g\.zones\.pop\(\);[\s\S]{0,120}return false;/,
    "a popped zone leaves the board identical and must say so");
  // removeZone: bails before touching anything when the remainder will not fold.
  const rm = src.slice(src.indexOf("removeZone(id)"));
  assert.match(rm.slice(0, 500), /rebuilt = false; return false;/,
    "an unrebuildable removal touched nothing and must say so");
});
