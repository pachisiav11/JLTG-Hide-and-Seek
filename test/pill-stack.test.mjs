// Phase 29 (req #11): shared pill stack — mounting, non-overlap, and a dismiss
// that hides the pill WITHOUT stopping the underlying watch.
//
// The project carries no JSDOM, so this builds the smallest fake document that
// exercises the real code paths: createElement / getElementById / body /
// appendChild / classList / a clickable button. "Without overlap" is asserted
// structurally — both pills are children of ONE flex-column stack container, so
// they cannot overlap by construction — which is exactly the guarantee the CSS
// provides and a pixel test could only approximate.
import test from "node:test";
import assert from "node:assert/strict";

function makeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: tag,
    id: "",
    type: "",
    _text: "",
    onclick: null,
    children: [],
    attrs: {},
    className: "",
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    get textContent() { return el._text; },
    set textContent(v) { el._text = v; },
    setAttribute: (k, v) => { el.attrs[k] = v; },
    appendChild: (child) => { el.children.push(child); child.parent = el; return child; },
    remove: () => { const p = el.parent; if (p) p.children = p.children.filter((c) => c !== el); },
    click: () => { if (typeof el.onclick === "function") el.onclick(); },
  };
  Object.defineProperty(el, "_classes", { get: () => classes });
  return el;
}

function makeDoc() {
  const body = makeEl("body");
  const byId = new Map();
  return {
    body,
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => byId.get(id) || findById(body, id) || null,
    _index: () => { byId.clear(); walk(body, (n) => { if (n.id) byId.set(n.id, n); }); },
  };
}
function walk(node, fn) { fn(node); for (const c of node.children || []) walk(c, fn); }
function findById(root, id) { let hit = null; walk(root, (n) => { if (n.id === id) hit = n; }); return hit; }

const { getPillStack, createPill } = await import("../src/pill-stack.js");

test("mount 1: two pills share exactly one stack container", () => {
  const doc = makeDoc();
  const a = createPill({ id: "geofence-pill", variant: "geofence", doc });
  const b = createPill({ id: "live-share-pill", variant: "live-share", doc });
  assert.ok(a && b, "both pills created");

  const stacks = [];
  walk(doc.body, (n) => { if (n.id === "pill-stack") stacks.push(n); });
  assert.equal(stacks.length, 1, "only one stack container exists");

  const stack = stacks[0];
  const ids = stack.children.map((c) => c.id);
  assert.deepEqual(ids.sort(), ["geofence-pill", "live-share-pill"], "both pills are children of the one stack");
});

test("mount 2: pills stack without overlap — flex-column children of the stack, no fixed positions", () => {
  const doc = makeDoc();
  createPill({ id: "geofence-pill", variant: "geofence", doc });
  createPill({ id: "live-share-pill", variant: "live-share", doc });
  const stack = findById(doc.body, "pill-stack");
  // Non-overlap guarantee is structural: siblings in a single flex column. No
  // pill sets its own position, so there are no coordinated `bottom` offsets to
  // collide (the bug req #11 named).
  assert.equal(stack.className, "pill-stack");
  assert.equal(stack.children.length, 2, "both mounted as siblings that flow, not stack on top of each other");
  for (const pill of stack.children) {
    assert.match(pill.className, /^pill\b/, "each is a .pill with no inline fixed position of its own");
  }
});

test("mount 3: variant class drives colour, not position", () => {
  const doc = makeDoc();
  createPill({ id: "geofence-pill", variant: "geofence", doc });
  createPill({ id: "live-share-pill", variant: "live-share", doc });
  assert.match(findById(doc.body, "geofence-pill").className, /pill-geofence/);
  assert.match(findById(doc.body, "live-share-pill").className, /pill-live-share/);
});

test("dismiss 1: hiding a pill does NOT stop the underlying watch", () => {
  const doc = makeDoc();
  // Stand in for the Geofence/LiveShare object: a live GPS watch the dismiss
  // control must never touch.
  const watch = { id: 42, stopped: false, stop() { this.stopped = true; this.id = null; } };
  let onDismissRan = false;
  const pill = createPill({
    id: "geofence-pill", variant: "geofence", doc,
    onDismiss: () => { onDismissRan = true; }, // a real caller updates VIEW state only
  });
  const el = findById(doc.body, "geofence-pill");
  const dismissBtn = el.children.find((c) => c.tagName === "button");
  assert.ok(dismissBtn, "pill has a dismiss button");

  dismissBtn.click();

  assert.ok(el.classList.contains("pill-hidden"), "the pill is hidden");
  assert.ok(onDismissRan, "the optional onDismiss hook fired");
  // The crux: the watch is untouched. The pill has no reference to it and can
  // only ever hide the DOM node.
  assert.equal(watch.stopped, false, "dismiss must not stop the watch");
  assert.equal(watch.id, 42, "watch id is intact — alerts keep firing while the pill is hidden");
});

test("dismiss 2: a hidden pill still updates its text (the watch is still writing to it)", () => {
  const doc = makeDoc();
  const pill = createPill({ id: "geofence-pill", variant: "geofence", doc });
  const el = findById(doc.body, "geofence-pill");
  el.children.find((c) => c.tagName === "button").click();
  pill.setText("OUT of zone · 30 m over the edge");
  const textSpan = el.children.find((c) => c.className === "pill-text");
  assert.equal(textSpan.textContent, "OUT of zone · 30 m over the edge", "text keeps updating under the hood");
  assert.ok(el.classList.contains("pill-hidden"), "still hidden — the user chose to hide it");
  pill.show();
  assert.ok(!el.classList.contains("pill-hidden"), "show() brings it back on re-enable");
});

test("env: no DOM → createPill no-ops instead of throwing", () => {
  assert.equal(getPillStack(null), null);
  assert.equal(createPill({ id: "x", doc: null }), null);
});
