// A board that spans two countries has no single "1st admin division".
//
// The division levels are fixed per COUNTRY (overpass-lines.js: COUNTRY_DIVISION_LEVELS), and
// the card applies the resolved level across the board's whole bbox. Resolving that country
// from the board CENTRE alone was wrong for any board straddling a level-2 border: a
// Singapore/Johor board resolves Singapore, whose 1st division is level 5, and then draws
// level-5 features over the Malaysian half — where level 5 is not Malaysia's 1st division at
// all. That is a confidently wrong line, and a wrong reference line eliminates real regions.
//
// The same failure mode as the earlier level-4 test that returned a single way named "Johor":
// not an empty answer, a wrong one.
import "./helpers/turf-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardProbePoints, resolveBoardDivisions } from "../src/lines.js";
import { turf, squareArea } from "./helpers/turf-env.mjs";

// A board is identified here by the country each probe point falls in, keyed by rounded
// coordinate — the same key loadCountryDivisions caches under.
const withProbes = (byPoint) => {
  const store = new Map();
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    const lat = Number(u.searchParams.get("lat")).toFixed(2);
    const lon = Number(u.searchParams.get("lon")).toFixed(2);
    const hit = byPoint(Number(lat), Number(lon));
    return { ok: true, status: 200, json: async () => hit };
  };
  return {
    dbImpl: {
      get: async (_s, k) => store.get(k) || null,
      put: async (_s, v) => { store.set(v.key, v); },
    },
  };
};

const SG = { country: "Singapore", levels: [5, 6] };
const MY = { country: "Malaysia", levels: [4] };
const SEA = { country: null, levels: [] };

test("probes sample the play area, and never land outside it", () => {
  const board = squareArea([103.8, 1.35], 0.4);
  const pts = boardProbePoints(board);
  assert.ok(pts.length >= 5, "a square board gets the full grid");
  for (const [lat, lon] of pts) {
    assert.ok(turf.booleanPointInPolygon(turf.point([lon, lat]), turf.feature(board)),
      `probe ${lat},${lon} must be inside the play area`);
  }
});

test("a board whose BBOX crosses a border, but whose polygon does not, still resolves", () => {
  // The regression this pins, and the reason probes are polygon-filtered rather than bbox
  // corners: Singapore's bbox corners are in Johor and Hong Kong's are in Shenzhen. Sampling
  // the bbox reported a border crossing on both, disabling the border cards on exactly the
  // boards people play. An L-shaped board hugging the SW corner has the same shape of problem.
  const L = { type: "Polygon", coordinates: [[
    [103.6, 1.2], [103.9, 1.2], [103.9, 1.3], [103.7, 1.3], [103.7, 1.5], [103.6, 1.5], [103.6, 1.2],
  ]] };
  const pts = boardProbePoints(L);
  assert.ok(pts.length > 1, "the notch must not starve the sample");
  for (const [lat, lon] of pts) {
    // The NE quadrant (the notch) is over the border in this scenario and must never be probed.
    assert.ok(!(lat > 1.32 && lon > 103.72), `probe ${lat},${lon} is in the notch, outside the board`);
  }
});

test("a board thinner than the grid spacing still gets a probe", () => {
  // A narrow strip — a coastal board, a river corridor — can miss every grid cell centre.
  // Zero probes would mean zero countries, and the card would fall back on a board that has
  // a perfectly good answer.
  const strip = { type: "Polygon", coordinates: [[
    [103.60, 1.3500], [104.00, 1.3500], [104.00, 1.3505], [103.60, 1.3505], [103.60, 1.3500],
  ]] };
  const pts = boardProbePoints(strip);
  assert.ok(pts.length >= 1, "never zero probes");
  for (const [lat, lon] of pts) {
    assert.ok(lat >= 1.3499 && lat <= 1.3506 && lon >= 103.59 && lon <= 104.01, "probe on the strip");
  }
});

test("a board inside ONE country resolves that country's levels", async () => {
  const { dbImpl } = withProbes(() => SG);
  const out = await resolveBoardDivisions(squareArea([103.8, 1.35], 0.2), { proxyBase: "http://x", dbImpl });
  assert.equal(out.country, "Singapore");
  assert.deepEqual(out.levels, [5, 6]);
});

test("a board spanning two countries resolves to NULL, not to the centre's country", async () => {
  // The Singapore/Johor board: centre over Singapore, the northern half over Malaysia. Before
  // the fix this returned Singapore and drew level 5 across Johor. Measured live at 44%
  // Malaysia, far past the dominance threshold.
  const { dbImpl } = withProbes((lat) => (lat > 1.40 ? MY : SG));
  const out = await resolveBoardDivisions(squareArea([103.8, 1.40], 0.4), { proxyBase: "http://x", dbImpl });
  assert.equal(out, null, "no nationwide level is right on both halves");
});

test("a fingertip sliver of the neighbour does NOT disable the card", async () => {
  // The regression the strict any-disagreement rule caused, and the reason for a dominance
  // threshold. A hand-drawn Singapore board clips Johor (measured 1/21 probes) and a Hong Kong
  // board clips Shenzhen (1/19). Under the strict rule both lost their border cards entirely —
  // and Hong Kong is a viable playing area, so that was a worse bug than the one being fixed.
  // Only the northernmost sliver of this board is Malaysia.
  const { dbImpl } = withProbes((lat) => (lat > 1.487 ? MY : SG));
  const out = await resolveBoardDivisions(squareArea([103.8, 1.35], 0.3), { proxyBase: "http://x", dbImpl });
  assert.equal(out?.country, "Singapore", "a ~5% sliver is fingertip slop, not a border crossing");
});

test("the dominance threshold sits in the measured gap, not on a judgement call", async () => {
  // Live-measured: slop is ~5% of probes, genuine straddles are 24% (Detroit+Windsor) through
  // 44% (Basel, SG+Johor, HK+Shenzhen). Nothing in between. A board that is 24% the neighbour
  // is binational and must fall back — Detroit+Windsor is the least lopsided real case.
  const { dbImpl } = withProbes((lat) => (lat > 1.35 + 0.15 * 0.52 ? MY : SG));
  const out = await resolveBoardDivisions(squareArea([103.8, 1.35], 0.3), { proxyBase: "http://x", dbImpl });
  assert.equal(out, null, "a Detroit/Windsor-shaped split must fall back");
});

test("an ocean probe is silence, not disagreement", async () => {
  // Every coastal board has bbox corners in the sea — Mumbai, Singapore, NYC. Counting a
  // no-country probe as a different country would disable the border cards on exactly the
  // boards people play.
  const { dbImpl } = withProbes((lat, lon) => (lon < 103.7 ? SEA : SG));
  const out = await resolveBoardDivisions(squareArea([103.8, 1.35], 0.3), { proxyBase: "http://x", dbImpl });
  assert.equal(out?.country, "Singapore", "sea probes must not veto a single-country board");
});

test("one flaky probe does not veto a board the others agree on", async () => {
  let calls = 0;
  const store = new Map();
  globalThis.fetch = async () => {
    calls++;
    if (calls === 2) throw new Error("Overpass 504");
    return { ok: true, status: 200, json: async () => SG };
  };
  const dbImpl = { get: async (_s, k) => store.get(k) || null, put: async (_s, v) => { store.set(v.key, v); } };
  const out = await resolveBoardDivisions(squareArea([103.8, 1.35], 0.3), { proxyBase: "http://x", dbImpl });
  assert.equal(out?.country, "Singapore");
});

test("probes run in parallel, but capped — a serial regression would cost minutes", async () => {
  // 25 sequential Overpass round-trips before the card can draw is minutes on a cold cache,
  // for a card that used to need one probe. The cap is equally load-bearing: firing all 25 at
  // once gets the proxy rate-limited, and a throttled probe is a lost vote that skews the tally.
  let inFlight = 0, peak = 0;
  const store = new Map();
  globalThis.fetch = async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { ok: true, status: 200, json: async () => SG };
  };
  const dbImpl = { get: async (_s, k) => store.get(k) || null, put: async (_s, v) => { store.set(v.key, v); } };
  const out = await resolveBoardDivisions(squareArea([103.8, 1.35], 0.5), { proxyBase: "http://x", dbImpl });
  assert.equal(out?.country, "Singapore");
  assert.ok(peak > 1, "must not be serial");
  assert.ok(peak <= 5, `must be capped, saw ${peak} concurrent`);
});

test("a probe that NEVER returns cannot hang the card", async () => {
  // Found by playtesting Detroit+Windsor live: 23 of 25 probes came back and two never did.
  // Because the tally awaited all of them, the card hung forever — no line, no fallback, no
  // error. The proxy retries a busy Overpass endpoint internally, so from here "slow" and
  // "never" are indistinguishable; only a deadline tells them apart.
  const store = new Map();
  let n = 0;
  globalThis.fetch = async () => {
    if (++n % 7 === 0) return new Promise(() => {}); // never settles
    return { ok: true, status: 200, json: async () => SG };
  };
  const dbImpl = { get: async (_s, k) => store.get(k) || null, put: async (_s, v) => { store.set(v.key, v); } };
  const out = await Promise.race([
    resolveBoardDivisions(squareArea([103.8, 1.35], 0.5), { proxyBase: "http://x", dbImpl }),
    new Promise((r) => setTimeout(() => r("HUNG"), 25000)),
  ]);
  assert.notEqual(out, "HUNG", "must decide on the votes that arrived");
  assert.equal(out?.country, "Singapore");
});

test("a board entirely at sea resolves to null rather than guessing", async () => {
  const { dbImpl } = withProbes(() => SEA);
  const out = await resolveBoardDivisions(squareArea([0, 0], 0.3), { proxyBase: "http://x", dbImpl });
  assert.equal(out, null);
});
