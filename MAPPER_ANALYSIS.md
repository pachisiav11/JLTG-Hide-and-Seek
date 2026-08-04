# Deep Analysis — `taibeled/JetLagHideAndSeek`

### A mapper review, with measured geometry, and an improvement programme for JLTG Hide & Seek

**Date:** 2026-08-03
**Subject:** <https://github.com/taibeled/JetLagHideAndSeek> @ `f0ff392`
**Comparator:** `pachisiav11/JLTG-Hide-and-Seek` (skim-level read, per instruction)

---

## 0. How this analysis was produced, and what it is worth

I cloned the reference mapper, installed it with pnpm, ran the Astro dev server, and drove
it in headless Chromium across **40 scripted test games** on a fixed board. Every number in
this document that is labelled "measured" came out of the running application, not out of
reading the source.

**One constraint you should know about before trusting anything here.** The sandbox this ran
in blocks outbound HTTPS to every OSM-ecosystem host — `overpass-api.de`,
`overpass.private.coffee`, `maps.mail.ru`, `photon.komoot.io`, `tile.openstreetmap.org`,
`basemaps.cartocdn.com` all return connection failures at the proxy. That is an environment
network policy, not something your permission grant could lift. So I could not hit the real
Overpass API.

What I did instead, and why it still produces trustworthy results:

| Layer | How it was handled | Fidelity |
|---|---|---|
| App code | Real, unmodified except a 12-line `window.__jl` store export for readout | **Real** |
| Geometry engine (turf, ArcGIS geodesic ops, d3-geo-voronoi) | Real, running in the browser | **Real** |
| Coastline data | The **actual** `public/coastline50.geojson` shipped in the repo | **Real** |
| ArcGIS WASM assets | Served from local `node_modules` instead of Esri's CDN | **Real bytes** |
| Overpass responses | Local stub that parses the app's real query strings and answers with plausible Tokyo-area OSM elements | **Synthetic content, real query→geometry path** |
| Basemap tiles | 1×1 PNG stub | Cosmetic only |

So: **every algorithm, projection, buffer, boolean op and Voronoi partition in this document
executed for real.** What is synthetic is the *content* of the POI lists (how many museums
Tokyo actually has), which affects none of the geometric conclusions. Where a claim rests on
reading code rather than running it, I say so explicitly.

Board used throughout: a 1.00° × 0.75° rectangle over Greater Tokyo / Tokyo Bay,
`[139.30, 35.30] → [140.30, 36.05]`, **7 533 km²** by geodesic area. It straddles real
Natural Earth coastline, which is what makes the coastline testing meaningful.

---

## 1. The reference mapper at a glance

| | |
|---|---|
| **Stack** | Astro 5 + React 19 islands, TypeScript, Tailwind + shadcn/Radix |
| **Map** | Leaflet 1.9 + react-leaflet 5, CARTO/OSM/Thunderforest raster tiles |
| **Geometry** | `@turf/turf` 7.2, `@arcgis/core` 4.32 (geodesic buffer + geodetic distance), `d3-geo-voronoi` |
| **State** | nanostores + `@nanostores/persistent` → **localStorage**. No accounts, no backend. |
| **Data** | OpenStreetMap via **Overpass**; Photon (Komoot) for geocoding; bundled Natural Earth coastline |
| **Persistence** | localStorage for state; **Cache Storage API** in three named buckets for network responses |
| **Sharing** | `CompressionStream('deflate')` → base64url in the URL; Pastebin fallback over 2 000 chars |
| **Size** | ~15 300 lines of TS/TSX in `src/`; `ZoneSidebar.tsx` alone is 1 414 |
| **Tests** | 4 vitest files (`compress`, `importers`, `operators`, `stationManipulations`) — thin |
| **Onboarding** | A 20-step in-app tutorial (`TutorialDialog.tsx`, 1 212 lines) |
| **Claim** | "over 48 question variations" |

It is a **single-player seeker's deduction tool**. There is no multiplayer, no live location,
no timers, no notifications, no hider client. Everything is one browser tab, and the whole
game state fits in a URL. That is a deliberate and, for its purpose, excellent choice — and
it is the single biggest architectural difference from your project, which is a full
two-sided field app.

---

## 2. The core model — one idea, applied five ways

Everything reduces to a single invariant:

```
activeArea  =  board  ∩  constraint₁  ∩  constraint₂  ∩  …  ∩  constraintₙ
```

Each question contributes exactly one polygon constraint. The pipeline
(`src/maps/index.ts:applyQuestionsToMapGeoData`) folds them in order:

```ts
for (const question of questions) {
    mapGeoData = await adjustMapGeoDataForQuestion(question, mapGeoData);
}
```

and each `adjustPer*` ends in the same primitive (`geo-utils/operators.ts`):

```ts
export const modifyMapData = (mapData, modifications, withinModifications) => {
    if (withinModifications) return turf.intersect([mapData, modifications]);
    return turf.intersect([mapData, holedMask(modifications)]);   // i.e. subtract
};
```

`holedMask(X)` = `difference(WORLD, X)` where `WORLD` is the full `[-180,-90,180,90]`
rectangle. So "outside" is implemented as intersect-with-the-complement rather than as
`difference`. This is a genuinely good choice: it means *every* question, in *both* of its
answers, goes through one code path, so there is no asymmetry between the "yes" and "no"
branches to get wrong.

**Rendering inverts the same trick.** The map does not draw the surviving area — it draws
`holedMask(activeArea)`, a world-sized polygon with the survivor punched out as a hole, so
Leaflet paints everything *eliminated* and leaves the answer transparent
(`Map.tsx:199-214`). One polygon, one layer, no per-question shading to stack up.

### 2.1 Verified: the fold is exact

Two answers to the same question must partition the board with no gap and no overlap. Measured:

| Test | "Yes" area | "No" area | Sum | Board |
|---|---:|---:|---:|---:|
| Radius 25 km @ Tokyo Stn | 1 963.3 | 5 569.7 | **7 533.0** | 7 533.0 |
| Matching, nearest airport | 5 849.2 | 1 683.8 | **7 533.0** | 7 533.0 |
| Matching, admin level 4 | 1 993.1 | 5 539.9 | **7 533.0** | 7 533.0 |
| Measuring, coastline | 1 889.7 | 5 643.2 | **7 533.0** | 7 533.0 |

Exact to the printed precision in every case. This is the property that matters most in a
deduction tool and it holds.

---

## 3. Question-by-question

There are five question *engines*. The "48 variations" are parameterisations of these five.

### 3.1 Radius — `src/maps/questions/radius.ts` (53 lines)

> *"Are you within X of me?"*

```ts
const circle = await arcBuffer(featureCollection([point]), question.radius, question.unit);
return modifyMapData(mapData, circle, question.within);
```

**Geometry.** Not `turf.circle`. It converts the point to an ArcGIS geometry, calls
`geodesicBufferOperator.executeMany` with `maxDeviation = 3 feet`, and converts back. That is a
true geodesic buffer on the WGS84 ellipsoid with an adaptive vertex count, not an N-gon.

**Measured accuracy.** 25 km radius → **1 963.3 km²**. Analytic πr² = 1 963.50 km².
**Error 0.01 %.** A `turf.circle(…, {steps: 32})` would be ~0.6 % small; at `steps: 64`,
~0.16 %. The ArcGIS path is materially better and the cost is a WASM module (see §7.1).

**Failure modes.** None found in the geometry. `radius: 0` is allowed by the schema
(`.min(0)`), which produces an empty constraint — a question that eliminates everything.

### 3.2 Thermometer — `src/maps/questions/thermometer.ts` (71 lines)

> *"I travelled from A to B. Are you warmer (closer to B) or colder?"*

This is the perpendicular bisector of A and B — but it is **not** computed as a bisector:

```ts
const voronoi = geoSpatialVoronoi(featureCollection([pointA, pointB]));
return turf.intersect([mapData, voronoi.features[question.warmer ? 1 : 0]]);
```

A two-seed spherical Voronoi *is* the geodesic bisector, and reusing the Voronoi engine means
the thermometer and the nearest-of-category questions can never disagree about what "closer"
means. Cheap, elegant, and correct.

**Measured.** 40 km radius around Tokyo Station + thermometer warmer→Yokohama: 1 438.6 km²
survives, Tokyo Station **excluded**, Yokohama **included**. Correct orientation, and the
`warmer` flag maps to `features[1]` (the B cell) as it should.

**Note.** This engine needs no network at all. Radius + Thermometer are the only two
question families that make **zero** external requests — confirmed: 0 Overpass calls across
five radius/thermometer games.

### 3.3 Matching — `src/maps/questions/matching.ts` (430 lines)

> *"Is your nearest X the same as mine?"* / *"Are we in the same zone?"*

Five structurally different sub-families hide behind one card:

| Sub-family | Constraint geometry | Data source |
|---|---|---|
| `zone`, `letter-zone` | An admin **polygon** (or the union of all same-initial polygons) | Overpass `is_in` → `rel(pivot)` |
| `airport`, `major-city`, `*-full`, `custom-points` | The seeker's **Voronoi cell** over the point set | Overpass POI query |
| `custom-zone` | A user-drawn polygon | Local |
| `same-first-letter-station`, `same-length-station`, `same-train-line` | **No map polygon at all** — returns `false` | Filters hiding zones only (§5) |
| `aquarium`…`park` (home-game) | **No map polygon at all** — returns `false` | Filters hiding zones only (§5) |

That fourth and fifth row is the important structural fact: **eleven of the matching variants
do not shade the map at all.** They are *only* meaningful when "Display hiding zones" is on,
because they operate on the discrete station list, not on continuous area. A user who has not
enabled hiding-zone mode can add a "Same train line" question and watch it do nothing. The
UI groups them under a "Hiding Zone Mode" heading (`schema.ts:318`), which is the only
signal.

**Nice touches found in the source.**

- Airports are filtered to `["aeroway"="aerodrome"]["iata"]` — the IATA tag as a proxy for
  "commercial", with `_.uniqBy(iata)` to collapse multi-polygon aerodromes. Genuinely clever.
- Major cities use `["population"~"^[1-9]+[0-9]{6}$"]` — a **regex on the string** rather than
  `(if:number(t["population"])>1000000)`, with a source comment saying the regex is faster.
  It is, substantially, because Overpass evaluates regexes on the index. It also silently
  misses `population=1,200,000` and `population=1.2e6`.
- `letter-zone` pushes the initial-letter filter into Overpass as `["name:en"~"^T.+"]` rather
  than fetching all zones and filtering client-side.
- `determineMatchingBoundary` is `_.memoize`d on a key that includes the **board itself**
  (`polyGeoJSON` or `mapGeoLocation`), so changing the board correctly invalidates.
- `letter-zone` runs `turf.simplify(tolerance: 0.001)` before union with a comment reading
  *"It's either simplify or crash."*

**Measured.** Nearest-airport same/different partitioned the board exactly (5 849.2 / 1 683.8).
Admin-level-4 "same zone" produced 1 993.1 km²; the fixture prefecture polygon is
0.62° × 0.32° at 35.66 °N ≈ 1 988 km² planar — the 0.3 % difference is the geodesic correction,
i.e. correct. `letter-zone` at level 4 returned exactly the same polygon as `zone` when only
one zone shared the initial, which is right.

### 3.4 Measuring — `src/maps/questions/measuring.ts` (480 lines)

> *"Are you closer to the nearest X than I am?"*

The shared engine is subtle and worth spelling out, because it is the cleverest thing in the
codebase:

```ts
const placeData = await determineMeasuringBoundary(question);   // the reference geometry
return arcBufferToPoint(featureCollection(placeData), question.lat, question.lng);
```

`arcBufferToPoint` (`operators.ts:101`) computes the **geodetic distance from the reference
geometry to the seeker's own position**, then buffers the reference by exactly that distance.
The seeker never types a distance. The app derives it. The resulting polygon's boundary
passes exactly through the seeker, and "hider is closer" = keep the inside.

That is the right design, and it is worth stealing: it removes an entire class of user error
(mis-measuring your own distance) and it makes the question self-consistent by construction.

#### 3.4.1 Coastline — the geometry, in detail

You asked specifically about this one. Here is the whole algorithm:

```ts
const coastline = turf.lineToPolygon(await fetchCoastline());        // lines → land polygons
const d = turf.pointToPolygonDistance(seekerPoint, coastline,
                                      { units: "miles", method: "geodesic" });   // SIGNED
return [ turf.difference(
    turf.bboxPolygon(bBox),
    turf.buffer(turf.bboxClip(coastline, bboxExtension(bBox, d)), d,
                { units: "miles", steps: 64 })
) ];
```

Four things are happening, and only one of them is obvious.

1. **`lineToPolygon` turns 1 429 coastline LineStrings into land polygons.** Closed rings
   become islands; open lines are auto-closed with a straight chord.
2. **`pointToPolygonDistance` returns a *signed* distance.** Negative when the point is
   *inside* a polygon, i.e. **on land**. Measured: Tokyo Station → **−3.9248 mi**;
   mid-Tokyo-Bay → **+4.470 mi**. The sign is load-bearing.
3. **`turf.buffer` with a negative distance is an erosion.** So for a seeker on land the land
   polygon is shrunk inward by their distance-to-shore, and `bbox − erodedLand` = *everything
   within d of the coast, on both the land and the sea side*. For a seeker at sea the same
   expression dilates instead. One formula, both cases, no branch.
4. **`bboxExtension` uses `Math.abs(distance)`** — the only place the sign is deliberately
   discarded, and correctly so, because it is only padding the clip window.

**Verified against brute force.** I reimplemented the pipeline standalone and scored it
against a brute-force geodesic point-to-segment distance field over the real Natural Earth
data:

| Check | Result |
|---|---|
| Signed distance vs brute force, 4 test points | **agreement to 4 decimal places** (Δ = 0.0000 mi) |
| Standalone reproduction vs in-browser run | 1 889.6 vs **1 889.7 km²** |
| Region membership, 61×61 grid, threshold 3.925 mi | **96.05 % agreement** |
| Points app **includes** that truth excludes | 147 |
| Points app **excludes** that truth includes | **0** |

That last row is the one that matters. **The error is entirely one-sided: the coastline
question never eliminates area it should have kept.** It only fails to eliminate area it
could have. For a tool whose job is to narrow down a hider, that is the correct direction to
be wrong in — a conservative superset can cost you a turn, an aggressive subset loses you the
game.

But the magnitude is not small:

| Seeker | Threshold | Disagreement | Worst over-inclusion |
|---|---:|---:|---|
| Tokyo Station | 3.925 mi | 4.07 % of grid | **3.788 mi** (96.5 % of threshold) |
| Chiba (coastal) | 1.998 mi | 8.07 % of grid | **5.716 mi** (286 % of threshold) |

**The closer the seeker is to the coast, the worse the relative error gets.** At a 2-mile
threshold the kept region extends nearly 6 miles inland in places. The cause is turf's
buffer, which works in a locally-scaled planar space and polygonises with `steps: 64`;
erosion of a narrow or convoluted landform degrades fast.

#### 3.4.2 The coastline *data* is the real limit

`public/coastline50.geojson` is **Natural Earth 1:50 m**. Measured properties of the actual
shipped file:

| | |
|---|---|
| Features (LineStrings) | 1 429 |
| Vertices | 60 416 |
| Total length | 595 193 km |
| **Median vertex spacing** | **7.65 km** |
| p90 spacing | 19.77 km |
| p99 spacing | 43.02 km |
| Max spacing | 136.9 km |
| File size | 3.99 MB (shipped to every user, cached permanently) |

Median vertex spacing of **7.65 km** against a question whose thresholds are routinely
1–5 miles. **The coastline data is coarser than the measurement being made on it.** In my
3.5° × 3.5° analysis box around Tokyo — a region with one of the most convoluted coastlines
on earth — the file contains **three** line segments. Tokyo Bay is a smooth curve. Every
inlet, river mouth, breakwater and reclaimed island is absent.

This is a deliberate trade (one 4 MB file, works offline, works worldwide, zero queries) and
for a coarse "are you within 20 miles of the sea" question on a national board it is fine.
For a city board it is the single largest source of error in the whole application — larger
than the buffer approximation, larger than any projection issue.

#### 3.4.3 The other measuring variants

| Variant | Reference geometry | Source | Notes |
|---|---|---|---|
| `airport` | MultiPoint of IATA aerodromes | Overpass | measured 730.6 km² survivor |
| `city` | MultiPoint of 1 M+ cities | Overpass | |
| `highspeed-measure-shinkansen` | `[highspeed=yes]` ways, **grouped, stitched, simplified, buffered 0.001°** | Overpass | see below |
| `admin-measure` | `polygonToLine` of the containing admin polygon — the **border**, not the area | Overpass `is_in` | |
| `*-full` (11 POI types) | MultiPoint | Overpass, `timeout:60` | guarded at 1 000 elements |
| `custom-measure` | User-drawn points/lines/polygons | Local | |
| `mcdonalds`, `seven11`, `rail-measure` | **none** — returns `false` | — | hiding-zone-only (§5) |

The high-speed rail path is the most interesting: `groupObjects` does a **union-find** over
`name` / `name:en` / `network` tags to cluster the hundreds of OSM ways belonging to one
service, then `connectToSeparateLines` greedily chains them nose-to-tail (reversing segments
as needed, splitting when the gap exceeds 0.01°). That is real work, and it is the same
problem your `overpass-lines.js` solves.

**Measured**: high-speed measure from Chiba → 5 682.8 km² survivor, correctly hugging the
Tokaido/Tohoku alignments. Admin-border measure from Tokyo Station → 4 116.8 km², a band
straddling the prefecture boundary. Both behaved as designed.

### 3.5 Tentacles — `src/maps/questions/tentacles.ts` (188 lines)

> *"Of these N places within R of me, which are you nearest?"*

```ts
const points = await findTentacleLocations(question);      // Overpass around: R
const voronoi = geoSpatialVoronoi(points);
const correctPolygon = voronoi.features.find(f =>
    f.properties.site.properties.name === question.location.properties.name);
return turf.intersect([mapData, correctPolygon, circle]);
```

Cell ∩ radius ∩ board. Straightforward — with two behaviours worth flagging.

**A "miss" is a radius question.** If the hider is not near any of them,
`question.location === false`, and `maps/index.ts:91` routes it to
`adjustPerRadius({...question.data, within: false})`. Measured: 15-mile museum tentacle with
no location → survivor **5 702.4 km²**; board minus a 15-mile disc = 7 533.0 − 1 830.5 =
5 702.5. **Exact.** Elegant reuse.

**Matching is by `name` string, not by identity.** `findTentacleLocations` de-duplicates on
name and the cell is found by name comparison. Two distinct parks both tagged
`name=Central Park` inside one radius collapse to one candidate, and the second one's cell is
unreachable. Unnamed features are dropped entirely (`if (!element.tags["name"] && !element.tags["name:en"]) return;`).

**A single candidate degenerates.** Measured: 15-mile zoo tentacle with only one zoo in
range → survivor 1 830.5 km², i.e. **exactly the radius disc**. The Voronoi has one cell
covering the world, so the question degrades to "are you within 15 miles". Correct, but the
UI does not warn. (Your implementation *does* warn — `layers.js` emits *"Only one line is in
range, so this can only tell you whether the hider is within…"*. That is better.)

---

## 4. The geometry toolkit

### 4.1 `geoSpatialVoronoi` — and why you should not copy it

`geo-utils/voronoi.ts` is 28 lines and does something unusual:

```ts
const voronoi = geoVoronoi()(points).polygons();          // spherical Delaunay/Voronoi
const projected = geoProject(geoStitch(voronoi),
    geoMercator().translate([0,0]).precision(0.005));     // → planar Mercator
turf.coordEach(projected, c => { c[0] *= ratio; c[1] *= -ratio; });
return turf.toWgs84(projected);                            // → back to lng/lat
```

It computes a **true spherical** Voronoi with `d3-geo-voronoi`, then round-trips through
Mercator with a hand-derived scale ratio (`scaleReference / 480.5`, with a source comment
admitting *"961 is the default scale for some reason"*) purely to turn d3's spherical polygons
into GeoJSON turf will accept.

**I benchmarked this against your longitude-compression approach and against raw planar
`turf.voronoi`**, scoring all three against brute-force geodesic nearest-seed over a 71×71
grid:

| Board | Raw planar lng/lat | **Lng-compressed (JLTG's)** | Geodesic d3-geo-voronoi |
|---|---:|---:|---:|
| Tokyo, 8 sparse seeds | 5.69 % wrong | **0.02 %** | 0.04 % |
| Tokyo, 25 dense seeds | 6.57 % wrong | **0.08 %** | 0.04 % |
| Reykjavík (64 °N), 8 seeds | **27.67 % wrong** | **0.14 %** | 0.18 % |
| Singapore (1.3 °N), 8 seeds | 0.02 % | **0.00 %** | 0.02 % |

Read that table carefully, because it contains the most actionable finding in this document:

- Raw planar `turf.voronoi` on raw lng/lat is **catastrophic** at high latitude — more than a
  quarter of the board assigned to the wrong seed at Reykjavík.
- **Your longitude-compressed Voronoi and their geodesic Voronoi are indistinguishable.**
  Both sit at the resolution floor of the sampling grid. Neither is meaningfully better.

**So: do not migrate to `d3-geo-voronoi`.** Your `tools.js:voronoiCells` comment already
identifies the exact failure mode and the exact fix, and the fix works as well as the
heavyweight alternative at a fraction of the cost and complexity. This is one place where your
implementation is already at parity and a "modernise to match" instinct would be a
regression. Your `dejitter` handling of coincident points and your refusal to swallow a
degenerate partition are both things the reference does *not* do.

### 4.2 `safeUnion` / `holedMask` / `arcBuffer`

- `safeUnion` short-circuits a one-feature collection (turf's `union` returns `null` there) and
  throws otherwise. Small, but it is the kind of thing that silently produces `null` and then
  a blank map.
- `arcBuffer` sets `maxDeviation: 3 feet` converted into the working unit — an adaptive-density
  buffer rather than a fixed step count.
- `arcBufferToPoint` is the derive-the-distance trick from §3.4.

---

## 5. Hiding-zone mode — the second engine

This is the part of the app that has no equivalent in a naive implementation, and it is where
`ZoneSidebar.tsx`'s 1 414 lines go.

**The idea.** Instead of (only) shading continuous area, enumerate every plausible *hiding
zone* — a circle of radius `hidingRadius` (default 0.5 mi) around every transit stop on the
board — and eliminate whole zones. This matches how the actual game is played: the hider is
near a station, not at an arbitrary point.

```ts
let circles = places.map(p => turf.circle(getCoord(p), radius, { steps: 32, properties: p }))
                    .filter(c => !turf.booleanWithin(c, unionized));
```

then each hiding-zone-only question filters the array:

- **`same-first-letter-station`** — find the station nearest the *seeker*, take its initial,
  keep/drop zones whose station shares it.
- **`same-length-station`** — three-way (`shorter` / `same` / `longer`) on `name.length`.
- **`same-train-line`** — `trainLineNodeFinder` resolves the seeker's nearest station to its
  OSM node, asks `wr(bn)` for the ways/relations through it, re-queries all ways with matching
  `name`/`name:en`/`network`, collects **every node id** on them, and keeps zones whose station
  id is in the set.
- **`mcdonalds` / `seven11` / `rail-measure`** — nearest-brand distance compared per zone, with
  a `± hidingRadius` slop term so a zone is kept if *any* point in it could satisfy the answer.

Selecting a zone runs `selectionProcess`, which re-derives the map for *that* zone
specifically — including re-querying POIs around the candidate station and expanding the
search radius adaptively (`if (minimumPoint.distance + hidingRadius*2 > radius) radius = …`).

**Places offered as hiding zones** (multi-select, unioned in one Overpass query): railway
station / halt / stop, tram stop, bus stop, ferry terminal, ferry platform, funicular,
aerialway station, subway-only, non-subway-only, light rail station, light rail halt.

**Custom station lists** can be imported from **CSV, GeoJSON or KML** (`importers.ts`), by
file upload *or* raw URL, with column-name sniffing (`lat|latitude`, `lng|lon|long|longitude`,
`name|title|station|label`) and a lightweight KML `<Placemark>` parser aimed at Google MyMaps
exports. They can replace or be merged with the OSM set. `mergeDuplicateStation` groups
same-named stops whose zones mutually overlap and averages them to one centre.

`same-train-line` correctly refuses to run on a custom-only list ("Custom-only lists don't have
reliable OSM IDs") rather than producing a wrong answer.

### 5.1 Measured — 11 hiding-zone games, 50 stations on the board

| Game | Question | Zones surviving | Check |
|---|---|---:|---|
| G4a | *(baseline, no questions)* | **50 / 50** | ✅ |
| G4b | Station starts with same letter as mine | **6** — Tachikawa, Tamachi, Tokyo, Totsuka, Tsudanuma, Tsurumi | nearest to seeker is *Tokyo* → initial **T**; all six correct ✅ |
| G4c | …different letter | **44** | 50 − 6, **exact complement** ✅ |
| G4d | Station name same length as mine | **7** — Chiba, Inage, Kanda, Ofuna, Omiya, Tokyo, Urawa | all exactly 5 chars, as *Tokyo* ✅ |
| G4e | …shorter | **2** — Soka, Ueno | both 4 chars ✅ |
| G4f | …longer | **41** | **7 + 2 + 41 = 50** — the ternary partitions exactly ✅ |
| G4g | Same train line as mine (from Tokyo Stn) | **40** | union of all lines through Tokyo ✅ |
| G4h | *Not* same line as mine (from Shinjuku) | **30** | 20 on Shinjuku's lines ✅ |
| G4i | Nearest McDonald's closer than mine | **13** | ✅ |
| G4j | Nearest station closer than mine (`rail-measure`) | **50 — unchanged** | ⚠️ see below |
| G4k | Radius 25 km, within | **35**, area 1 963.3 km² | area questions prune zones too ✅ |

Two findings from this table.

**The three-way name-length question partitions exactly** (7 + 2 + 41 = 50). Ternary answers
carry meaningfully more information than binary ones and cost nothing extra — worth stealing.

**`rail-measure` does not prune the zone list.** Reading `ZoneSidebar.tsx:286-428`, the bulk
filter loop handles `same-first-letter-station`, `same-length-station`, `same-train-line`,
`mcdonalds` and `seven11` — but **not** `rail-measure`. That variant is only applied inside
`selectionProcess` (`:1290`), i.e. when you click into one specific zone. So adding a "train
station" measuring question in hiding-zone mode appears to do nothing to the zone list, and
silently does something different from its siblings. Measured: 50/50 zones survive.

---

## 6. Hider mode — auto-answering

Setting `hiderMode` to a lat/lng makes the app answer every *unlocked* question **for** the
hider (`maps/index.ts:hiderifyQuestion` → `hiderify*` per family). It is a rehearsal and
verification tool, not a play mode.

**The strongest correctness result in this review.** I placed a hider at Kichijōji
(139.5797, 35.7031) and ran six games. In every one, the app derived the answers itself and I
then checked whether the true hiding location survived its own eliminations:

| Game | Auto-derived answer(s) | Survivor | Hider retained? |
|---|---|---:|---|
| Radius 20 km @ Tokyo Stn | `within=true` | 1 256.5 km² | ✅ |
| Thermometer Tokyo→Yokohama | `warmer=false` | 5 265.1 km² | ✅ |
| Measuring coastline | `hiderCloser=false` | 5 643.2 km² | ✅ |
| Matching nearest airport | `same=true` | 5 849.2 km² | ✅ |
| Tentacles, 15 mi museums | picked `Museum 55` | 142.0 km² | ✅ |
| **All four compounded** | all of the above | **581.4 km²** | ✅ |

The 20 km disc measured 1 256.5 km² against an analytic 1 256.64 — again 0.01 %. And the
four-question compound game narrowed 7 533 km² to 581.4 km² (7.7 %) **without ever losing the
true location**. The elimination pipeline is sound.

Two implementation details worth noting:

- `hiderifyMatching` / `hiderifyMeasuring` fall back to a **geometric** test — run
  `adjustPer*`, take `holedMask` of the result, and flip the answer if the hider is inside the
  eliminated region — rather than reimplementing each question's logic twice. Compact, and it
  guarantees the auto-answer and the elimination can never disagree.
- It only runs on questions where `data.drag === true` (the schema comment says *"drag is now
  synonymous with unlocked"*). Locked questions keep their manual answer.

---

## 7. Bugs, fragilities and sharp edges found

Ordered by how much damage they can do in a real game.

### 7.1 🔴 The buffer engine is a runtime CDN fetch, and it fails **silently**

`@arcgis/core`'s `config.assetsPath` defaults to `https://js.arcgis.com/4.32/@arcgis/core/assets`
and the app never overrides it. Every `arcBuffer` call therefore requires fetching
`esri/geometry/support/pe-wasm.wasm` from **Esri's CDN at runtime**.

I hit this accidentally — my first test run had the CDN blocked, and here is what happened:

| Question | Expected survivor | Actual survivor with WASM unavailable |
|---|---:|---:|
| Radius 25 km, within | 1 963.3 km² | **7 533.0 km² (whole board)** |
| Radius 25 km, outside | 5 569.7 km² | **7 533.0 km² (whole board)** |
| Two radii intersected | 930.5 km² | **7 533.0 km² (whole board)** |

The question card sat there in the sidebar looking applied. The map showed no elimination. **No
error toast appeared**, because `adjustMapGeoDataForQuestion` wraps everything in
`try { … } catch { return mapGeoData; }` (`maps/index.ts:105`) — a failed constraint degrades to
*no constraint*, indistinguishable from a question that legitimately eliminates nothing.

This affects **Radius, Tentacles and every buffer-based Measuring variant** — the majority of
the app. And note the irony: this is a PWA with a service worker and a permanent cache, whose
central geometric primitive cannot run offline.

The fix is two lines — `import config from "@arcgis/core/config"; config.assetsPath = "/assets"` plus
copying `node_modules/@arcgis/core/assets` into `public/` at build time. The *reporting* fix
(surface the failure instead of swallowing it) matters more.

### 7.2 🟠 Hiding-zone initialisation has a no-recovery race

`ZoneSidebar.tsx:175`:

```ts
useEffect(() => {
    if (!map || isLoading.get()) return;      // ← bails, schedules nothing
    …
}, [$questionFinishedMapData, $displayHidingZones, …]);
```

`isLoading` is **not** in the dependency array, and the early return schedules no retry. The
effect's main trigger is `questionFinishedMapData` changing — but `Map.tsx` sets
`questionFinishedMapData` *inside* its `try` block and only clears `isLoading` in the following
`finally` (`Map.tsx:216` vs `:239`). So there is a window in which the effect fires, sees
`isLoading === true`, returns, and never runs again until some *other* dependency changes.

**Be precise about what I actually observed.** Under a clean setup — one fresh browser per
scenario, no CPU contention — all 11 zone games populated reliably at ~3 s. Under load (two
browsers in parallel, or a reused browser context across pages), several runs never populated
at all and had to be recovered by toggling "Display hiding zones" off and on. So this is a
**latent race that surfaces under load**, not a constant failure. On a mid-range phone
recomputing a heavy board — precisely the situation this feature warns about ("*This feature can
drastically slow down your device*") — the window is widest.

Fix is one line: add `$isLoading` to the dependency array, or subscribe to it going false.

### 7.3 🟠 `"kilometers" units is invalid` under concurrency

Observed intermittently, and only in multi-question games — a `arcBuffer` call landing before
`geodesicBufferOperator.load()` has resolved, so the ArcGIS unit table is not yet populated.
`innateArcBuffer` awaits `load()` on every call, but `executeMany` is reached by several
questions concurrently. Harmless in effect (the fold retries on the next render) but it is the
same swallow-and-continue path as §7.1, so a *persistent* version of this failure would also be
invisible.

### 7.4 🟠 Coastline over-inclusion scales badly at small thresholds

Quantified in §3.4.1: at a ~2-mile threshold the kept region reaches nearly 6 miles inland.
Safe direction, but it means the coastline question is much weaker than it appears on a city
board.

### 7.5 🟡 The "major city" population regex has a real hole

`["population"~"^[1-9]+[0-9]{6}$"]` requires **every digit before the final six to be
non-zero**. Tested:

| `population` value | Matched? | |
|---|---|---|
| `1200000` (1.2 M) | ✅ | |
| `3760000` | ✅ | |
| `13960000` (13.96 M) | ✅ | |
| `12000000` | ✅ | |
| **`10000000`** (10 M) | ❌ | **missed** |
| **`10500000`** (10.5 M) | ❌ | **missed** |
| `1,200,000` | ❌ | formatted values missed |
| `999999` | ❌ | correct |

So a city of 10.5 million is excluded from "major city" while one of 1.2 million is included.
Any 8+ digit value with a zero in the second position falls through the hole — which is a
sizeable band of the world's largest cities. `^[1-9][0-9]{6,}$` fixes it without giving up the
index-friendly regex. Comma- and space-formatted values are a separate, unavoidable OSM data
issue.

### 7.6 🟡 Tentacles de-duplicates by display name

§3.5. Two same-named POIs in one radius silently become one candidate.

### 7.6b 🟡 `rail-measure` silently skips the bulk zone filter

§5.1 / G4j. In hiding-zone mode the "train station" measuring question prunes nothing from the
zone list — it is handled only in the per-zone drill-down, unlike `mcdonalds` and `seven11`
which sit right next to it in the schema and *are* handled in the bulk loop. Measured: 50/50
zones survive a question that should have cut it down. An inconsistency, not a geometry error.

### 7.7 🟡 `cors-anywhere.com` in the sharing path

`PASTEBIN_API_POST_URL = "https://cors-anywhere.com/https://pastebin.com/api/api_post.php"` —
the user's Pastebin **API key** and their entire game state transit a third-party CORS proxy
of unclear provenance. Also a hard availability dependency for large-board sharing.

### 7.8 🟡 Board-scoped Overpass queries can be enormous

`findPlacesInZone` inlines the *entire* board polygon into a `(poly:"lat lng lat lng …")` filter,
with no simplification. A hand-drawn 500-vertex board produces a multi-kilobyte GET URL for
every question. There is a `turf.simplify` in `determineMapBoundaries` (over 10 000 coords) but
not on the query path.

### 7.9 🟢 Thin test coverage

Four vitest files covering compression, importers, operators and station merging. **No tests at
all** for the five question engines, the Voronoi, the coastline pipeline, or the fold. The
README lists "Tests" as an open contribution request.

---

## 8. What needs the Google Maps API, and what does not

This is the section you asked for explicitly. The reference mapper uses **no Google API of any
kind** — this table is therefore a direct statement of what is achievable without one, verified
by running it.

### 8.1 Fully achievable with **no** Google API

| Capability | Free replacement | Evidence |
|---|---|---|
| Basemap tiles | CARTO Voyager/Light/Dark, OSM Carto, Thunderforest | 5 styles shipped, no key for the first four |
| Place / boundary search | **Photon** (`photon.komoot.io`), no key, no quota | `geocode.ts`, 37 lines |
| Board polygon from a named place | Overpass `relation(osm_id); out geom;` | `determineGeoJSON` |
| POI category search (11 types) | Overpass `nwr[amenity=…]` etc. | `LOCATION_FIRST_TAG` |
| Brand search (McDonald's, 7-Eleven) | Overpass `["brand:wikidata"="Q38076"]` | exact, better than a text search |
| Airports, "commercial" filter | `["aeroway"="aerodrome"]["iata"]` | IATA as commercial proxy |
| Cities over 1 M | `[place=city]["population"~…]` | |
| Admin boundaries, any level 2–10 | `is_in(lat,lng); rel(pivot)["admin_level"=N]; out geom;` | polygon **and** border |
| Transit stops, 12 kinds | `[railway=station]`, `[highway=bus_stop]`, … | multi-select union |
| **Rail line geometry** | `[highspeed=yes]`, `wr(bn)` line resolution | Google exposes **none** of this |
| Train-line membership ("same line?") | node → ways → all node ids | genuinely impossible on Google |
| Coastline | Bundled Natural Earth 1:50 m, or `natural=coastline` via Overpass | |
| Geodesic buffers | `@arcgis/core` geodesic operators, or turf | 0.01 % measured |
| Voronoi / nearest partition | `d3-geo-voronoi`, or turf + lng-compression | both 0.0x % |
| Routing-free distance | turf geodesic | |
| Offline operation | Cache Storage + localStorage + PWA | modulo §7.1 |

### 8.2 Genuinely needs Google (or another commercial provider)

| Capability | Why OSM/Overpass cannot do it | Bearing on Hide & Seek |
|---|---|---|
| **Transit departure times / live schedules** | Overpass has route *geometry* and stop *positions*, not timetables. GTFS exists but is per-agency, unversioned, and not queryable worldwide. | **High** — this is your documented reason for staying on Google, and it is correct. |
| **Transit routing / journey planning** | ditto | High for a field app |
| Walking/driving ETA and directions | OSRM/Valhalla/GraphHopper exist but need hosting or a paid key | Medium |
| Street View / imagery | no equivalent | Low for the mapper, real for a field app |
| Business hours, ratings, "is it open" | OSM `opening_hours` is sparse and unreliable | Low |
| Rich POI ranking / relevance | Places ranks by prominence; Overpass returns everything unranked | Medium — affects "which 6 museums do we offer?" |
| Autocomplete UX quality | Photon is good but noticeably weaker on partial/typo input | Low–Medium |
| Guaranteed SLA / rate ceiling | Overpass is a volunteer service; the reference ships **three** hosts with fallback for exactly this reason | Medium |

### 8.3 The honest summary

**Every geometric and deductive capability in the Hide & Seek mapper is achievable with no
Google API at all.** The reference proves it by doing it. What Google buys you is
*transit-time truth* and *POI relevance* — neither of which is geometry, and one of which
(transit timing) is genuinely load-bearing for a two-sided field app like yours and is not
load-bearing at all for a single-player deduction tool like theirs.

Which is to say: your architectural decision to keep Google Maps is correct **for your product**,
and their decision to avoid it is correct **for theirs**. The interesting question is not
"should you switch" — it is "which specific data layers should you source from OSM *in addition*,
because Google cannot provide them at all." That list is short and precise:

1. **Rail/metro line geometry** — you already do this (`overpass-lines.js`). Correct call.
2. **Train-line membership** for a "same line?" question — the `wr(bn)` node-set trick (§5).
3. **Coastline** — `natural=coastline`, sourced live rather than hand-drawn.
4. **Admin boundaries at arbitrary level** — `is_in` + `rel(pivot)`, both as area *and* as border.
5. **Brand-exact chains** — `brand:wikidata` beats any keyword search.
6. **Peaks/mountains** — `natural=peak` is exact; Google has no such category.

---

## 9. Feature inventory — things they have that are worth wanting

Not all of these are worth building. Marked accordingly.

| Feature | What it is | Worth it for JLTG? |
|---|---|---|
| **Planning mode** | Unlocked questions render only their *boundary line*, not their elimination — preview a cut before committing | ⭐ **Yes** |
| **Lock / unlock per question** | Locked = committed & applied; unlocked = draggable & previewable | ⭐ **Yes** |
| **Hide per question** | Keep a question in the list but exclude it from the fold | ⭐ **Yes** |
| **Derive the seeker's distance automatically** | §3.4 `arcBufferToPoint` | ⭐ **Yes** |
| **URL-compressed share** | `CompressionStream('deflate')` + base64url; whole game in a link | ⭐ **Yes** |
| Hider mode / auto-answer | Verification & rehearsal | ⚠️ You removed this deliberately — but see §10.6 |
| **Three Overpass hosts + automatic fallback + custom host** | Resilience against a volunteer service | ⭐ **Yes** |
| **Three separate caches** (question / zone / permanent) | Different invalidation lifetimes | ⭐ **Yes** |
| **In-flight request de-duplication** | `inFlightFetches` map | ⭐ **Yes** |
| Hiding-zone enumeration | §5 — discrete zones instead of continuous area | ⭐⭐ **Strongly** |
| Custom station import (CSV/GeoJSON/KML/URL) | Google MyMaps interop | ⭐ **Yes** |
| Merge duplicate stations | Same name + overlapping zones → one | ✅ Nice |
| 20-step in-app tutorial | | ✅ You have `GUIDE.md`; in-app is better |
| Custom question presets | Save/share/edit a configured question | ✅ Nice |
| Multi-region boards (add/subtract) | `additionalMapGeoLocations` with `added: false` = subtract | ⭐ **Yes** |
| Print / export map | `leaflet-easyprint` | ✅ Nice |
| Permanent map overlay | A user GeoJSON always drawn | ✅ Nice |
| Google Plus Codes input | Optional coordinate format | ➖ Minor |
| Auto-save toggle | Batch expensive recomputes | ⭐ **Yes** (you have heavy recompute) |

---

## 10. Improvement programme for JLTG Hide & Seek

Scoped to respect the constraints already recorded in your `IMPROVEMENTS.md` §"Explicitly not
recommended": **no stack rewrite, no migration off Google Maps, no reversion to forced
auto-answer, no premature backend.** Everything below is a pattern to borrow, not a stack to
adopt.

Priority key: **P0** = correctness, do first · **P1** = high value/effort ratio ·
**P2** = worthwhile · **P3** = polish/optional.

### 10.1 Correctness and trust (P0)

**A. Never let a failed question look like an applied question.**
This is the reference's worst bug (§7.1) and it is a class of bug, not an instance. Audit every
`catch` in your elimination path for the same shape: a swallowed failure that returns the
*unmodified* area is indistinguishable from a question that legitimately eliminated nothing.
Your `layers.js` already has `failedSteps` and a "N questions failed" banner — good — and your
`tools.js` comment on the Voronoi degeneration shows you have already been bitten by exactly
this. Extend that discipline to **every** step: a step that could not compute must render
visibly distinct from a step that computed an empty elimination.

**B. Adopt the two-answers-partition-the-board invariant as a test.**
For every question type, assert `area(yes) + area(no) == area(board)` within tolerance. It is
one property test that catches an enormous family of geometry bugs, and it is exactly the check
that gave me confidence in the reference (§2.1). You have no equivalent assertion today.

**C. Add a "hider survives" regression test.**
Independently of whether you ever ship auto-answer as a *feature*, use it as a *test harness*:
place a synthetic hider, derive the truthful answer to each question, fold all of them, assert
the hider is still inside. §6 is that test, run six ways. This is the single highest-value test
you can add, because it directly tests the property the whole app exists to guarantee.

**D. Fix the coastline accuracy story before it decides a game.**
Your coastline is currently hand-drawn in the 2nd-admin-division style (per your README) or
sourced from `natural=coastline`. Either way, note from §3.4.2 that Natural Earth 1:50 m is
*not* a viable source for a city board — if you were considering it as an offline fallback,
size the error first. `natural=coastline` from Overpass, clipped to the board, is 2–3 orders of
magnitude more precise and is a single unambiguous worldwide tag (your own `questions.js`
comment already says so). Prefer it unconditionally.

**E. Buffer erosion is where accuracy dies.**
If you buffer any polygon *inward* (coastline-from-land, water bodies), measure the result
rather than trusting turf. §3.4.1 shows a 286 % relative overshoot at a 2-mile threshold. If
you need better, compute a signed distance field on a grid and contour it, or clip to a
locally-projected CRS (UTM zone of the board centroid) before buffering.

### 10.2 Question-model upgrades (P1)

**F. Derive the seeker's own distance instead of asking for it.**
§3.4. Your measuring cards currently ask the seeker to type their distance D
(`layers.js:2098`, "Distance + within/beyond controls"). The reference computes it from the
seeker's pin. This removes a whole error class and makes the question self-consistent. Keep the
manual entry as an override for when the seeker measured differently, but default to derived.

**G. Add "hidden" and "locked" states per question.**
You have enable/disable. Add: **locked** (committed, cannot be dragged, still applies) and
**hidden** (retained in the list, excluded from the fold). The three states are different
intents and users conflate them today.

**H. Ship planning mode.**
Render an unlocked question's *boundary* without applying its elimination, so a seeker can see
where a cut would land before spending it. This is a genuinely strategic feature — Hide & Seek
is a game about *which question to ask*, and no other tool in this space helps with that
decision. Reference implementation is `determinePlanningPolygon` + `*PlanningPolygon` per family,
about 15 lines each.

**I. Warn on degenerate partitions.**
You already do this for Metro Lines ("Only one line is in range…"). Generalise it to every
Voronoi card: 1 candidate ⇒ the question is really a radius question; 2 candidates ⇒ it is
really a thermometer. Say so *before* the seeker spends the question.

**J. Add the train-line-membership question.**
"Is your nearest station on the same line as mine?" is one of the strongest questions in the
real game and is **impossible** on Google (§8.2). The reference's recipe: nearest station →
`node(id); wr(bn); out tags;` → re-query all ways sharing `name`/`name:en`/`network` → collect
every node id → membership test. You already have the rail sourcing in `overpass-lines.js`;
this is a small addition on top.

**K. Reconsider three-way answers.**
`same-length-station` is `shorter` / `same` / `longer`, not a boolean. Several of your cards
would carry more information as ternary. Cheap to add, materially better elimination.

### 10.3 The hiding-zone engine (P1 — the biggest single win)

**L. Enumerate discrete hiding zones, not just continuous area.**
This is the reference's most valuable idea and the one your architecture is *best* positioned
to exploit, because you already have the station layer (`stations.js`, `stations-layer.js`), a
rail filter, and a hiding-zone radius concept (Phase 5). The addition is:

1. Build a circle of `hidingRadius` around every enabled stop.
2. Drop circles wholly inside the eliminated region.
3. Let every question filter the *array* as well as shade the *area*.
4. Render surviving zones as a list the seeker can tick off, and a map layer.

The payoff is that a seeker stops reasoning about "3 200 km² of shading" and starts reasoning
about "9 stations left", which is how the game is actually won. It also unlocks the entire
class of station-relative questions (§5) that have no continuous-area meaning at all.

**M. Offer the four render styles.**
`zones` (circles) / `stations` (points) / `no-overlap` (unioned silhouette) / `no-display`
(list only). The `no-overlap` union is the readable one on a dense board.

**N. Per-zone drill-down.**
Clicking a zone re-derives the map *as if* the hider were there (`selectionProcess`), which
answers "if they're at Kandivali, what does that imply?" — very strong for endgame planning.

**O. Custom station lists.**
CSV/GeoJSON/KML import, by file or URL, merged with or replacing OSM. Your users will have
Google MyMaps files; `importers.ts` is 160 lines and handles all three formats with column
sniffing. Near-direct lift.

### 10.4 Data sourcing and resilience (P1–P2)

**P. Multiple Overpass hosts with automatic fallback.**
You have one proxy (`OVERPASS_PROXY_URL`). The reference ships three upstreams, tries the
selected one, silently falls through the rest, and **writes the successful response back into
the cache under the primary's key** so subsequent hits are warm. Add at minimum a secondary. A
volunteer Overpass instance being down should not end a game.

**Q. Segment your caches by lifetime.**
Three buckets: `CACHE` (per-question, cleared when the question list empties), `ZONE_CACHE`
(per-board), `PERMANENT_CACHE` (coastline, boundary geometry). You cache per board in IndexedDB
already; splitting by invalidation lifetime means a board change does not evict the 4 MB
coastline.

**R. De-duplicate in-flight requests.**
A small `Map<url, Promise>` in `cache.ts` (`inFlightFetches`). On a board where five questions all need the
station list, you currently issue five identical Overpass queries. This is free performance and
free politeness toward a volunteer service.

**S. Simplify board polygons before putting them in a query.**
§7.8. Your boards are user-drawn and can be vertex-heavy. `turf.simplify` at ~0.001° before
building the `(poly:…)` filter, with the *unsimplified* polygon still used for the actual
geometry.

**T. Use `brand:wikidata` for chains.**
`Q38076` = McDonald's, `Q259340` = 7-Eleven. Exact, language-independent, and immune to the
naming variance that defeats keyword search. Google's text search cannot match this.

### 10.5 Sharing, state and UX (P2)

**U. Whole-game-in-a-URL sharing.**
`CompressionStream('deflate')` → base64url → query param. ~35 lines total (`utils.ts:19-61`),
no backend, no accounts. For a game where players hand a phone around or coordinate over chat,
this is the highest-value 35 lines in the reference. **Do not copy their Pastebin
overflow path** — it routes the user's API key through `cors-anywhere.com` (§7.7). Your Render
service can hold an overflow blob far more safely, or you can accept the URL length limit.

**V. Auto-save toggle.**
When a board has many expensive steps, let the user batch edits and recompute once. You have
debounced autosave; the reference has an explicit toggle plus a manual Save button, which is
better when a single recompute costs seconds.

**W. Multi-region boards with subtraction.**
`additionalMapGeoLocations` entries carry `added: true|false`; added regions union into the
board, subtracted ones `turf.difference` out, and POI results are additionally filtered by
point-in-polygon against the subtracted set. "Mumbai plus Thane minus the harbour" becomes
expressible.

**X. Move the guide in-app.**
`GUIDE.md` is excellent and nobody will read it on a phone mid-game. A 20-step
arrow-key-navigable overlay keyed to real UI elements (`data-tutorial-id`) converts
documentation into onboarding.

**Y. Print/export the board.**
`leaflet-easyprint` equivalent. Seekers photograph their screen today; give them a clean export.

### 10.6 On auto-answer (P3, and a nuance)

Your `IMPROVEMENTS.md` says auto-answer was tried and removed deliberately, and that Phase 11
should be an optional *check*, never a reversion. I agree — and §6 shows exactly what that
check should look like. The reference's `hiderify*` functions are not a play mode; they are a
**consistency oracle**. Used as one, they answer "did we just eliminate the square the hider is
actually standing in?" — which is the question you want answered in a *post-game review*, not
during play. Ship it as a debrief tool and a test fixture, never as a live answer source.

> ⚠️ **Decision (2026-08-04): the "debrief tool" half of this recommendation is rejected; the
> test fixture stands.** The owner ruled out the app computing an answer in *any* form, and
> that includes a post-game debrief and the Phase 11 check. This paragraph underrated how
> thin the line is: a debrief tool is the same code, the same computation and the same claim
> to know the truth, separated from live answering only by when someone opens it — and
> nothing stops it being opened mid-game. The recommendation to keep it out of `src/` was
> also too weak. `oracle.js` has been moved to `test/oracle.js`, and
> `test/no-auto-answer.test.mjs` fails if any module under `src/` imports it, defines its own
> answer-deriving function, or if it reappears in the app's source tree or offline shell.
> There is no allowlist. The correctness property this section is really about — §10.1 item
> A, "a truthfully-answered board always retains the hider" — is unaffected: it is asserted
> on every commit by `test/hider-survives.test.mjs`.

### 10.7 Things to explicitly NOT copy

1. **Do not adopt `d3-geo-voronoi`.** §4.1 — measured parity with your existing
   longitude-compression, at higher cost and complexity. Your implementation is already right,
   and it handles coincident points and degenerate partitions, which theirs does not.
2. **Do not ship Natural Earth 1:50 m as your coastline.** §3.4.2 — 7.65 km median vertex
   spacing is unusable at city scale, and it is a 4 MB download.
3. **Do not route anything through `cors-anywhere.com`.** §7.7.
4. **Do not put the geometry engine behind a third-party CDN fetch.** §7.1. If you ever add
   ArcGIS operators, self-host the WASM.
5. **Do not swallow geometry exceptions into "no change".** §7.1, §10.1A.
6. **Do not copy the single-`useEffect`-with-a-loading-guard pattern.** §7.2.
7. **Do not drop Google Maps.** §8.3 — transit timing is real and load-bearing for your product.

### 10.8 Suggested order

| Phase | Items | Rationale |
|---|---|---|
| **1** | A, B, C | Correctness harness first; everything after is safer |
| **2** | F, G, H, I | Question-model upgrades, all small, all high-value |
| **3** | L, M, N, O | The hiding-zone engine — the big one |
| **4** | P, Q, R, S, T | Data resilience; do before real-world load |
| **5** | J, K, D, E | New questions + accuracy work |
| **6** | U, V, W, X, Y | Sharing and UX |

---

## 11. Where each project already wins

Stated plainly, because a review that only lists deficits is not useful.

**The reference is ahead on:** the hiding-zone engine (§5), planning mode, derived distances
(§3.4), question-state richness (lock/hide/collapse/colour), URL sharing, Overpass resilience,
cache segmentation, breadth of question variants (48), in-app onboarding, and the sheer
elegance of the intersect-with-complement fold (§2).

**Your project is ahead on:** being a *two-sided field application* rather than a single-player
tool — live location sharing, geofencing, push, timers, notes, a native APK, a relay server,
multiplayer design — none of which the reference attempts. Also on: Voronoi robustness
(dejitter, degenerate-partition detection, explicit failure surfacing), refusal to accept
self-intersecting or antimeridian-crossing rings, per-line rail filtering with an explicit
"we hid N lines from this partition" warning, a documented rationale for every question's data
source, and warning the user when a partition is degenerate. Your `questions.js` and
`overpass-lines.js` comments contain measured, dated, country-by-country justifications that
the reference simply does not have — including the observation that `admin_level=4` is not the
first division in Singapore, Portugal, Ireland or Hong Kong. That is a level of empirical care
the reference never reaches.

The honest summary is that they have built a better **deduction engine** and you have built a
better **game companion**. The improvement programme above is almost entirely about importing
the former into the latter.

---

## Appendix A — Test game log

40 scripted games on the 7 533 km² Greater Tokyo board (G1 ×5, G2 ×8, G3 ×10, G4 ×11, G5 ×6).

Seeker reference points: **Tokyo Stn** (139.7671, 35.6812), **Yokohama** (139.6222, 35.4657),
**Ōmiya** (139.6238, 35.9063), **Chiba** (140.1137, 35.6132), **Shinjuku** (139.7005, 35.6896).

### G1 — Radius & Thermometer (no network at all: 0 Overpass calls)

| # | Setup | Survivor km² | Cross-check |
|---|---|---:|---|
| G1a | no questions | 7 533.0 | board area |
| G1b | radius 25 km, within, Tokyo Stn | **1 963.3** | πr² = 1 963.50 → **0.01 % error** |
| G1c | radius 25 km, outside | **5 569.7** | 7 533.0 − 1 963.3 **exact** |
| G1d | radius 40 km within + thermometer warmer→Yokohama | 1 438.6 | Tokyo excluded, Yokohama included ✅ |
| G1e | radius 25 km Tokyo ∩ radius 30 km Yokohama | 930.5 | ✅ |

### G2 — Measuring

| # | Setup | Survivor km² | Notes |
|---|---|---:|---|
| G2a | coastline, hider closer, from Tokyo Stn | **1 889.7** | signed dist −3.9248 mi; standalone repro 1 889.6 |
| G2b | coastline, hider farther | **5 643.2** | exact complement of G2a |
| G2c | coastline, hider closer, from inland Ōmiya | 5 856.8 | Ōmiya out, Tokyo in, Chiba in ✅ |
| G2d | nearest airport, hider closer | 730.6 | |
| G2e | major city, hider farther | 7 088.1 | |
| G2f | high-speed rail, hider closer, from Chiba | 5 682.8 | grouped + stitched ways |
| G2g | admin border (level 4), hider closer | 4 116.8 | band across the prefecture line |
| G2h | museums (`-full`), hider closer | 4 766.4 | `timeout:60`, 1 000-element guard |

### G3 — Matching & Tentacles

| # | Setup | Survivor km² | Notes |
|---|---|---:|---|
| G3a | matching nearest airport, same | **5 849.2** | |
| G3b | …different | **1 683.8** | 5 849.2 + 1 683.8 = 7 533.0 **exact** |
| G3c | matching admin level 4, same zone | **1 993.1** | fixture polygon ≈ 1 988 km² planar; geodesic ✅ |
| G3d | …different zone | **5 539.9** | exact complement |
| G3e | letter-zone level 4, same initial | 1 993.1 | identical to G3c (only one T-zone) ✅ |
| G3f | matching major city, same | 2 068.4 | |
| G3g | matching theme park (`-full`), same | 3 770.0 | |
| G3h | tentacles 15 mi museums, **miss** | **5 702.4** | 7 533.0 − π(24.14 km)² = 5 702.5 **exact** |
| G3i | tentacles 15 mi zoos, hider at Ueno Zoo | 1 830.5 | = full disc; only 1 candidate ⇒ degenerate |
| G3j | tentacles 15 mi theme parks, hider at Disneyland | 895.2 | 3 candidates, proper cell |

### G4 — Hiding-zone mode

See §5.1 — 11 games, all verified against the station list by name.

### G5 — Hider mode (auto-answer)

See §6 — 6 games, hider retained in all, compound game 7 533 → 581.4 km².

### Geometry verification (outside the browser, real coastline data)

| Script | Result |
|---|---|
| `verify-coastline.mjs` | signed distance matches brute force to 4 dp at 4 test points; 96.05 % grid agreement; **0 unsafe exclusions** |
| `verify-coastline2.mjs` | NE-50m: 1 429 lines / 60 416 vertices / median spacing 7.65 km; over-inclusion up to 286 % of threshold |
| `verify-voronoi.mjs` | planar 5.7–27.7 % wrong · lng-compressed 0.00–0.14 % · geodesic 0.02–0.18 % |

## Appendix B — Overpass query catalogue

Every query shape the reference emits, captured live from the running app:

```
# board geometry
[out:json]; relation(<osm_id>); out geom;

# POIs inside a drawn board
[out:json][timeout:60]; ( nwr[tourism=museum](poly:"<lat lng lat lng …>"); ); out center;

# POIs inside a named region
[out:json]; relation(<id>);map_to_area->.region0; ( nwr[amenity=hospital](area.region0); ); out center;

# tentacles (radius around the seeker)
[out:json][timeout:25]; nwr["tourism"="zoo"](around:24140.16, 35.6812, 139.7671); out center;

# admin boundary containing a point
[out:json]; is_in(35.6812, 139.7671)->.a; rel(pivot.a)["admin_level"="4"]; out geom;

# same-initial admin zones
[out:json]; ( relation[admin_level=4]["name:en"~"^T.+"](poly:"…");
              relation[admin_level=4]["name"~"^T.+"](poly:"…"); ); out geom;

# commercial airports
[out:json]; ( nwr["aeroway"="aerodrome"]["iata"](poly:"…"); ); out center;

# cities over 1M
[out:json]; ( nwr[place=city]["population"~"^[1-9]+[0-9]{6}$"](poly:"…"); ); out center;

# high-speed rail
[out:json]; ( nwr[highspeed=yes](poly:"…"); ); out geom;

# brand-exact chains
[out:json]; ( nwr["brand:wikidata"="Q38076"](poly:"…"); ); out center;

# hiding zones (multi-select unioned)
[out:json]; ( nwr[railway=station](poly:"…"); nwr[railway=halt](poly:"…"); … ); out center;

# train-line membership, step 1 — what runs through this station?
[out:json]; node(<id>); wr(bn); out tags;

# train-line membership, step 2 — every node on those lines
[out:json]; ( wr["name"="Yamanote Line"]; wr["network"="JR East"]; … ); out geom;
```

## Appendix C — Reproducing this

```
scratchpad/
  ref-mapper/          clone @ f0ff392, pnpm install, pnpm exec astro dev
  fixtures.mjs         synthetic Tokyo OSM content
  overpass-stub.mjs    parses the app's real queries, answers from fixtures
  harness.mjs          Playwright driver; seeds localStorage, serves ArcGIS WASM locally
  geolib.mjs           area/bbox/containment helpers over the app's own turf build
  game-radius.mjs      G1  radius + thermometer
  game-measuring.mjs   G2  all measuring variants incl. coastline
  game-voronoi.mjs     G3  matching + tentacles
  game-zones.mjs       G4  hiding-zone mode
  game-hider.mjs       G5  hider mode / auto-answer
  verify-coastline.mjs     signed distance vs brute force, grid agreement
  verify-coastline2.mjs    NE-50m resolution stats, error-band quantification
  verify-voronoi.mjs       planar vs lng-compressed vs geodesic, 4 latitudes
```

One instrumentation change was made to the clone: a `window.__jl` export appended to
`src/lib/context.ts` exposing the nanostores for readout. No application logic was modified.
