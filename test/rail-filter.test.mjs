// Which rail modes and lines are IN PLAY is the player's decision about their board: a tram
// is a real way to travel, and "we're only playing on the Blue and Red lines" is a legitimate
// setup. So every mode and every line is switchable.
//
// The filter is stored as what's HIDDEN, which is the load-bearing choice tested here: a mode
// or line that appears later must default to VISIBLE, not vanish because an older game never
// listed it.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/turf-env.mjs";
import { groupIntoLines, railFilter, isLineVisible, ROUTE_MODES } from "../src/lines.js";
import { createGame, normalizeGame, prepareImport } from "../src/model.js";

const payload = () => ({
  lines: [
    { name: "Western Line (fast): Virar => Churchgate", ref: "W", route: "train", wayIds: [1] },
    { name: "Western Line (fast): Churchgate => Virar", ref: "W", route: "train", wayIds: [1, 2] },
    { name: "Line 1 (Versova → Ghatkopar)", ref: "1", route: "subway", wayIds: [3] },
    { name: "Line 1 (Ghatkopar → Versova)", ref: "1", route: "subway", wayIds: [3] },
    { name: "Line 3 (Aarey → Cuffe Parade)", ref: "3", route: "subway", wayIds: [4] },
    { name: "Tram 1: A => B", ref: "1", route: "tram", wayIds: [5] },
    { name: "Mumbai Monorail", ref: "M", route: "monorail", wayIds: [6] },
  ],
  ways: Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [i, [[19.0 + i / 100, 72.8], [19.01 + i / 100, 72.81]]])),
});

test("a tram and a metro sharing ref '1' stay separate lines", () => {
  // `ref` is only unique within a mode — Milan has tram 1 and metro M1, Paris has Métro 1 and
  // tram T1. Keying on ref alone would weld them into one "line" of two unrelated geometries,
  // and leave no way to hide one without the other.
  const groups = groupIntoLines(payload());
  const ones = groups.filter((l) => l.ref === "1");
  assert.equal(ones.length, 2, `expected tram 1 and metro 1 to stay apart, got ${ones.length}`);
  assert.deepEqual(ones.map((l) => l.route).sort(), ["subway", "tram"]);
  assert.deepEqual(new Set(groups.map((l) => l.key)).size, groups.length, "keys must be unique");
});

test("the route type survives grouping so modes can be filtered without refetching", () => {
  // The fetch is slow and fails ~64% of the time; re-querying per checkbox would be unusable.
  for (const l of groupIntoLines(payload())) {
    assert.ok(l.route, `${l.label} lost its route type`);
  }
  const routes = new Set(groupIntoLines(payload()).map((l) => l.route));
  assert.deepEqual([...routes].sort(), ["monorail", "subway", "train", "tram"]);
});

test("a fresh game hides nothing", () => {
  const f = railFilter(createGame());
  assert.equal(f.hiddenRoutes.size, 0);
  assert.equal(f.hiddenLines.size, 0);
  for (const l of groupIntoLines(payload())) assert.ok(isLineVisible(l, f), `${l.label} should be visible by default`);
});

test("hiding a MODE hides its lines and leaves the rest alone", () => {
  const f = railFilter({ railFilter: { hiddenRoutes: ["train"], hiddenLines: [] } });
  const groups = groupIntoLines(payload());
  const visible = groups.filter((l) => isLineVisible(l, f));
  assert.ok(!visible.some((l) => l.route === "train"), "train lines must be hidden");
  assert.ok(visible.some((l) => l.route === "subway"), "metro must be untouched");
  assert.ok(visible.some((l) => l.route === "tram"), "tram must be untouched");
});

test("hiding a single LINE leaves its mode's other lines showing", () => {
  // The actual ask: "in mumbai i am planning to play only on some metro lines".
  const groups = groupIntoLines(payload());
  const line1 = groups.find((l) => l.route === "subway" && l.ref === "1");
  const f = railFilter({ railFilter: { hiddenRoutes: [], hiddenLines: [line1.key] } });
  const visible = groups.filter((l) => isLineVisible(l, f));
  assert.ok(!visible.some((l) => l.key === line1.key), "Line 1 must be hidden");
  assert.ok(visible.some((l) => l.route === "subway" && l.ref === "3"), "Line 3 must still show");
});

test("a mode or line the filter has never heard of defaults to VISIBLE", () => {
  // The reason the filter stores what's HIDDEN. A new metro opens, or OSM starts tagging
  // monorails on this board: an allow-list written before it existed would silently drop it,
  // and the player would never know the map was incomplete.
  const f = railFilter({ railFilter: { hiddenRoutes: ["train"], hiddenLines: ["subway:1"] } });
  const brandNew = { key: "subway:9", ref: "9", route: "subway", label: "Line 9" };
  assert.ok(isLineVisible(brandNew, f), "a line added after the filter was written must show");
  const newMode = { key: "funicular:F", ref: "F", route: "funicular", label: "Funicular" };
  assert.ok(isLineVisible(newMode, f), "a mode added after the filter was written must show");
});

test("the filter persists on the game and survives normalize + import", () => {
  // It is per-BOARD: "we're playing the Blue and Red lines" is a fact about this game, and the
  // next game in the same city may use different ones.
  const g = createGame({ railFilter: { hiddenRoutes: ["tram"], hiddenLines: ["subway:1"] } });
  assert.deepEqual(g.railFilter.hiddenRoutes, ["tram"]);

  const round = normalizeGame(JSON.parse(JSON.stringify(g)));
  assert.deepEqual(round.railFilter.hiddenLines, ["subway:1"], "must survive a save/load round trip");

  const imported = prepareImport(JSON.parse(JSON.stringify(g)));
  assert.deepEqual(imported.railFilter.hiddenRoutes, ["tram"], "an imported board keeps its filter");
  assert.notEqual(imported.id, g.id, "...but still gets a fresh id");
});

test("a game saved before the filter existed loads with nothing hidden", () => {
  const old = { id: "g1", name: "old", zones: [], history: [], gameArea: null };
  const g = normalizeGame(old);
  assert.deepEqual(g.railFilter, { hiddenRoutes: [], hiddenLines: [] });
});

test("every mode offered has a colour and a label", () => {
  // The map is the only place a mode is identifiable — the filter checkbox and the stroke
  // have to agree, or hiding "Tram" and watching nothing change is indistinguishable from a bug.
  for (const m of ROUTE_MODES) {
    assert.match(m.colour, /^#[0-9a-f]{6}$/i, `${m.route} needs a hex colour`);
    assert.ok(m.label && m.label.length > 2, `${m.route} needs a human label`);
  }
  const colours = ROUTE_MODES.map((m) => m.colour);
  assert.equal(new Set(colours).size, colours.length, "two modes sharing a colour is unreadable");
  // Every mode the rail query can return must be offerable, or it would draw with no way to hide it.
  assert.deepEqual(ROUTE_MODES.map((m) => m.route).sort(), ["light_rail", "monorail", "subway", "train", "tram"]);
});
