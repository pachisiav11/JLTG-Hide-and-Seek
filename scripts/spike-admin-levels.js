#!/usr/bin/env node
// Spike: what admin_level is the Nth administrative division, per country?
//
// Re-runs the 2026-07-15 `is_in` spike (GUIDE.md §5.6.1) at ~5+ points per country so
// the "levels are consistent within a country" claim can be tested rather than assumed.
// The original 42-sample run found the 2nd division has no fixed level and varies WITHIN
// France, the UK, Canada and Germany; this widens the net to see whether that holds.
//
// Writes one JSON cache file and resumes from it, because Overpass fails ~64% of the
// time (GUIDE.md §5.6.4) and a cold re-run of 150 probes would be mostly wasted calls.
//
//   node scripts/spike-admin-levels.js            # fetch missing probes, then report
//   node scripts/spike-admin-levels.js --report   # report from cache only, no network
//
// Cache lives outside the repo (scratchpad) — it is raw spike data, not source.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// Endpoint order is the doc's MEASURED success order, not the order server.js uses.
// mail.ru 15/18, overpass-api.de 7/25, kumi 0/18 — kumi stays only as a last resort.
const ENDPOINTS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const CACHE = process.env.SPIKE_CACHE
  || "C:/Users/vihaa/AppData/Local/Temp/claude/D--Projects-JLTG/084d3442-183b-4134-9f9c-8d7931fa8a63/scratchpad/admin-levels-cache.json";

const FETCH_TIMEOUT_MS = 90_000;
const MAX_ROUNDS = 12;      // passes over the outstanding set
const PAUSE_BETWEEN_MS = 1_200;  // be a good citizen on a free public endpoint
const PAUSE_BETWEEN_ROUNDS_MS = 20_000;

// ---------------------------------------------------------------------------
// Probes. `country` groups them; `scale: "country"` marks the whole-nation probe
// (a centroid-ish interior point), which is how a country-scale board would derive.
// ---------------------------------------------------------------------------
const P = (country, name, lat, lon, scale = "city") => ({ country, name, lat, lon, scale });

const PROBES = [
  // --- India ---
  P("India", "COUNTRY (Nagpur, centroid)", 21.1458, 79.0882, "country"),
  P("India", "Mumbai", 19.0760, 72.8777), P("India", "Delhi", 28.6139, 77.2090),
  P("India", "Bengaluru", 12.9716, 77.5946), P("India", "Kolkata", 22.5726, 88.3639),
  P("India", "Chennai", 13.0827, 80.2707), P("India", "Hyderabad", 17.3850, 78.4867),
  P("India", "Ahmedabad", 23.0225, 72.5714), P("India", "Jaipur", 26.9124, 75.7873),

  // --- USA (top 10 by population + capital) ---
  P("USA", "COUNTRY (Lebanon KS, centroid)", 39.8283, -98.5795, "country"),
  P("USA", "New York", 40.7128, -74.0060), P("USA", "Los Angeles", 34.0522, -118.2437),
  P("USA", "Chicago", 41.8781, -87.6298), P("USA", "Houston", 29.7604, -95.3698),
  P("USA", "Phoenix", 33.4484, -112.0740), P("USA", "Philadelphia", 39.9526, -75.1652),
  P("USA", "San Antonio", 29.4241, -98.4936), P("USA", "San Diego", 32.7157, -117.1611),
  P("USA", "Dallas", 32.7767, -96.7970), P("USA", "San Jose", 37.3382, -121.8863),
  P("USA", "Washington DC", 38.9072, -77.0369), P("USA", "Boston", 42.3601, -71.0589),

  // --- Canada ---
  P("Canada", "COUNTRY (Baker Lake, centroid)", 64.3186, -96.0278, "country"),
  P("Canada", "Toronto", 43.6532, -79.3832), P("Canada", "Montreal", 45.5019, -73.5674),
  P("Canada", "Vancouver", 49.2827, -123.1207), P("Canada", "Calgary", 51.0447, -114.0719),
  P("Canada", "Ottawa", 45.4215, -75.6972), P("Canada", "Halifax", 44.6488, -63.5752),

  // --- Singapore (city-state: the interesting case is whether ANY sub-level exists) ---
  P("Singapore", "COUNTRY (centre)", 1.3521, 103.8198, "country"),
  P("Singapore", "Downtown Core", 1.2789, 103.8536), P("Singapore", "Jurong East", 1.3329, 103.7436),
  P("Singapore", "Woodlands", 1.4382, 103.7890), P("Singapore", "Tampines", 1.3496, 103.9568),
  P("Singapore", "Changi", 1.3644, 103.9915),

  // --- Japan (prefectures / subprefectures — the user's standardisation example) ---
  P("Japan", "COUNTRY (Nagano, centroid)", 36.2048, 138.2529, "country"),
  P("Japan", "Tokyo", 35.6762, 139.6503), P("Japan", "Osaka", 34.6937, 135.5023),
  P("Japan", "Nagoya", 35.1815, 136.9066), P("Japan", "Sapporo", 43.0618, 141.3545),
  P("Japan", "Fukuoka", 33.5904, 130.4017), P("Japan", "Kyoto", 35.0116, 135.7681),
  P("Japan", "Yokohama", 35.4437, 139.6380), P("Japan", "Sendai", 38.2682, 140.8694),
  P("Japan", "Hiroshima", 34.3853, 132.4553), P("Japan", "Naha (Okinawa)", 26.2124, 127.6809),

  // --- Vietnam ---
  P("Vietnam", "COUNTRY (Pleiku, centroid)", 13.9833, 108.0000, "country"),
  P("Vietnam", "Hanoi", 21.0285, 105.8542), P("Vietnam", "Ho Chi Minh City", 10.8231, 106.6297),
  P("Vietnam", "Da Nang", 16.0544, 108.2022), P("Vietnam", "Hai Phong", 20.8449, 106.6881),
  P("Vietnam", "Can Tho", 10.0452, 105.7469),

  // --- Thailand ---
  P("Thailand", "COUNTRY (Nakhon Sawan, centroid)", 15.7040, 100.1373, "country"),
  P("Thailand", "Bangkok", 13.7563, 100.5018), P("Thailand", "Chiang Mai", 18.7883, 98.9853),
  P("Thailand", "Phuket", 7.8804, 98.3923), P("Thailand", "Khon Kaen", 16.4419, 102.8360),
  P("Thailand", "Nakhon Ratchasima", 14.9799, 102.0977), P("Thailand", "Hat Yai", 7.0086, 100.4747),

  // --- UK (the four nations disagree — this is the headline intra-country case) ---
  P("UK", "COUNTRY (Whitendale Hanging Stones)", 54.0028, -2.5475, "country"),
  P("UK", "London", 51.5074, -0.1278), P("UK", "Manchester", 53.4808, -2.2426),
  P("UK", "Birmingham", 52.4862, -1.8904), P("UK", "Glasgow", 55.8642, -4.2518),
  P("UK", "Cardiff", 51.4816, -3.1791), P("UK", "Belfast", 54.5973, -5.9301),
  P("UK", "Edinburgh", 55.9533, -3.1883), P("UK", "Leeds", 53.8008, -1.5491),
  P("UK", "Bristol", 51.4545, -2.5879),

  // --- Switzerland ---
  P("Switzerland", "COUNTRY (Älggi-Alp, centroid)", 46.8010, 8.2275, "country"),
  P("Switzerland", "Zurich", 47.3769, 8.5417), P("Switzerland", "Geneva", 46.2044, 6.1432),
  P("Switzerland", "Bern", 46.9480, 7.4474), P("Switzerland", "Basel", 47.5596, 7.5886),
  P("Switzerland", "Lausanne", 46.5197, 6.6323), P("Switzerland", "Lugano", 46.0037, 8.9511),

  // --- Germany (Berlin's 4→9 jump was the original counterexample) ---
  P("Germany", "COUNTRY (Niederdorla, centroid)", 51.1657, 10.4515, "country"),
  P("Germany", "Berlin", 52.5200, 13.4050), P("Germany", "Munich", 48.1351, 11.5820),
  P("Germany", "Hamburg", 53.5511, 9.9937), P("Germany", "Cologne", 50.9375, 6.9603),
  P("Germany", "Frankfurt", 50.1109, 8.6821), P("Germany", "Bremen", 53.0793, 8.8017),

  // --- France (5 in Lyon, 6 in Toulouse) ---
  P("France", "COUNTRY (Vesdun, centroid)", 46.6034, 2.4368, "country"),
  P("France", "Paris", 48.8566, 2.3522), P("France", "Lyon", 45.7640, 4.8357),
  P("France", "Marseille", 43.2965, 5.3698), P("France", "Toulouse", 43.6047, 1.4442),
  P("France", "Bordeaux", 44.8378, -0.5792), P("France", "Lille", 50.6292, 3.0573),

  // --- Spain ---
  P("Spain", "COUNTRY (Getafe, centroid)", 40.3083, -3.7325, "country"),
  P("Spain", "Madrid", 40.4168, -3.7038), P("Spain", "Barcelona", 41.3874, 2.1686),
  P("Spain", "Valencia", 39.4699, -0.3763), P("Spain", "Seville", 37.3891, -5.9845),
  P("Spain", "Bilbao", 43.2630, -2.9350),

  // --- Italy ---
  P("Italy", "COUNTRY (Narni, centroid)", 42.5169, 12.5165, "country"),
  P("Italy", "Rome", 41.9028, 12.4964), P("Italy", "Milan", 45.4642, 9.1900),
  P("Italy", "Naples", 40.8518, 14.2681), P("Italy", "Turin", 45.0703, 7.6869),
  P("Italy", "Palermo", 38.1157, 13.3615),

  // --- Netherlands (level 3 is "Netherlands" repeated; 2nd division is 8) ---
  P("Netherlands", "COUNTRY (Lunteren, centroid)", 52.0870, 5.6200, "country"),
  P("Netherlands", "Amsterdam", 52.3676, 4.9041), P("Netherlands", "Rotterdam", 51.9244, 4.4777),
  P("Netherlands", "The Hague", 52.0705, 4.3007), P("Netherlands", "Utrecht", 52.0907, 5.1214),
  P("Netherlands", "Eindhoven", 51.4416, 5.4697),

  // --- Poland ---
  P("Poland", "COUNTRY (Piątek, centroid)", 52.0693, 19.4803, "country"),
  P("Poland", "Warsaw", 52.2297, 21.0122), P("Poland", "Krakow", 50.0647, 19.9450),
  P("Poland", "Lodz", 51.7592, 19.4560), P("Poland", "Wroclaw", 51.1079, 17.0385),
  P("Poland", "Gdansk", 54.3520, 18.6466),

  // --- Austria / Czechia / Hungary / Belgium / Portugal / Greece / Nordics / Ireland ---
  P("Austria", "COUNTRY (Bad Aussee, centroid)", 47.5162, 14.5501, "country"),
  P("Austria", "Vienna", 48.2082, 16.3738), P("Austria", "Graz", 47.0707, 15.4395),
  P("Austria", "Linz", 48.3069, 14.2858), P("Austria", "Salzburg", 47.8095, 13.0550),
  P("Austria", "Innsbruck", 47.2692, 11.4041),

  P("Czechia", "COUNTRY (Číhošť, centroid)", 49.7437, 15.3386, "country"),
  P("Czechia", "Prague", 50.0755, 14.4378), P("Czechia", "Brno", 49.1951, 16.6068),
  P("Czechia", "Ostrava", 49.8209, 18.2625), P("Czechia", "Plzeň", 49.7384, 13.3736),
  P("Czechia", "Olomouc", 49.5938, 17.2509),

  P("Hungary", "COUNTRY (Pusztavacs, centroid)", 47.1625, 19.5033, "country"),
  P("Hungary", "Budapest", 47.4979, 19.0402), P("Hungary", "Debrecen", 47.5316, 21.6273),
  P("Hungary", "Szeged", 46.2530, 20.1414), P("Hungary", "Pécs", 46.0727, 18.2323),
  P("Hungary", "Győr", 47.6875, 17.6504),

  P("Belgium", "COUNTRY (Nil-Saint-Vincent, centroid)", 50.6403, 4.6667, "country"),
  P("Belgium", "Brussels", 50.8503, 4.3517), P("Belgium", "Antwerp", 51.2194, 4.4025),
  P("Belgium", "Ghent", 51.0543, 3.7174), P("Belgium", "Liège", 50.6326, 5.5797),
  P("Belgium", "Bruges", 51.2093, 3.2247),

  P("Portugal", "COUNTRY (Vila de Rei, centroid)", 39.6952, -8.1503, "country"),
  P("Portugal", "Lisbon", 38.7223, -9.1393), P("Portugal", "Porto", 41.1579, -8.6291),
  P("Portugal", "Braga", 41.5454, -8.4265), P("Portugal", "Coimbra", 40.2033, -8.4103),
  P("Portugal", "Faro", 37.0194, -7.9304),

  P("Greece", "COUNTRY (Lamia, centroid)", 38.9000, 22.4333, "country"),
  P("Greece", "Athens", 37.9838, 23.7275), P("Greece", "Thessaloniki", 40.6401, 22.9444),
  P("Greece", "Patras", 38.2466, 21.7346), P("Greece", "Heraklion", 35.3387, 25.1442),
  P("Greece", "Larissa", 39.6390, 22.4191),

  P("Sweden", "COUNTRY (Ytterhogdal, centroid)", 62.1667, 14.9500, "country"),
  P("Sweden", "Stockholm", 59.3293, 18.0686), P("Sweden", "Gothenburg", 57.7089, 11.9746),
  P("Sweden", "Malmö", 55.6050, 13.0038), P("Sweden", "Uppsala", 59.8586, 17.6389),
  P("Sweden", "Linköping", 58.4109, 15.6216),

  P("Denmark", "COUNTRY (Viborg, centroid)", 56.2639, 9.5018, "country"),
  P("Denmark", "Copenhagen", 55.6761, 12.5683), P("Denmark", "Aarhus", 56.1629, 10.2039),
  P("Denmark", "Odense", 55.4038, 10.4024), P("Denmark", "Aalborg", 57.0488, 9.9217),
  P("Denmark", "Esbjerg", 55.4765, 8.4594),

  P("Norway", "COUNTRY (Steinkjer, centroid)", 64.0148, 11.4954, "country"),
  P("Norway", "Oslo", 59.9139, 10.7522), P("Norway", "Bergen", 60.3913, 5.3221),
  P("Norway", "Trondheim", 63.4305, 10.3951), P("Norway", "Stavanger", 58.9700, 5.7331),
  P("Norway", "Tromsø", 69.6492, 18.9553),

  P("Finland", "COUNTRY (Jyväskylä, centroid)", 62.2426, 25.7473, "country"),
  P("Finland", "Helsinki", 60.1699, 24.9384), P("Finland", "Tampere", 61.4978, 23.7610),
  P("Finland", "Turku", 60.4518, 22.2666), P("Finland", "Oulu", 65.0121, 25.4651),
  P("Finland", "Espoo", 60.2055, 24.6559),

  P("Ireland", "COUNTRY (Athlone, centroid)", 53.4239, -7.9407, "country"),
  P("Ireland", "Dublin", 53.3498, -6.2603), P("Ireland", "Cork", 51.8985, -8.4756),
  P("Ireland", "Galway", 53.2707, -9.0568), P("Ireland", "Limerick", 52.6638, -8.6267),
  P("Ireland", "Waterford", 52.2593, -7.1101),

  // --- Australia / New Zealand ---
  P("Australia", "COUNTRY (Lambert centre)", -25.6100, 134.3550, "country"),
  P("Australia", "Sydney", -33.8688, 151.2093), P("Australia", "Melbourne", -37.8136, 144.9631),
  P("Australia", "Brisbane", -27.4698, 153.0251), P("Australia", "Perth", -31.9505, 115.8605),
  P("Australia", "Adelaide", -34.9285, 138.6007), P("Australia", "Canberra", -35.2809, 149.1300),

  P("New Zealand", "COUNTRY (Nelson, centroid)", -41.2706, 173.2840, "country"),
  P("New Zealand", "Auckland", -36.8485, 174.7633), P("New Zealand", "Wellington", -41.2866, 174.7756),
  P("New Zealand", "Christchurch", -43.5321, 172.6362), P("New Zealand", "Hamilton NZ", -37.7870, 175.2793),
  P("New Zealand", "Dunedin", -45.8788, 170.5028),

  // --- Other high-value metros (dense transit, likely play areas) ---
  P("South Korea", "COUNTRY (Chungju, centroid)", 36.9910, 127.9259, "country"),
  P("South Korea", "Seoul", 37.5665, 126.9780), P("South Korea", "Busan", 35.1796, 129.0756),
  P("South Korea", "Incheon", 37.4563, 126.7052), P("South Korea", "Daegu", 35.8714, 128.6014),
  P("South Korea", "Daejeon", 36.3504, 127.3845),

  P("China", "COUNTRY (Lanzhou, centroid)", 35.8617, 104.1954, "country"),
  P("China", "Shanghai", 31.2304, 121.4737), P("China", "Beijing", 39.9042, 116.4074),
  P("China", "Guangzhou", 23.1291, 113.2644), P("China", "Shenzhen", 22.5431, 114.0579),
  P("China", "Chengdu", 30.5728, 104.0668),

  P("Hong Kong", "TERRITORY (centre)", 22.3193, 114.1694, "country"),
  P("Hong Kong", "Central", 22.2819, 114.1583), P("Hong Kong", "Kowloon", 22.3167, 114.1833),
  P("Hong Kong", "Sha Tin", 22.3771, 114.1974), P("Hong Kong", "Tsuen Wan", 22.3714, 114.1140),

  P("Taiwan", "COUNTRY (Puli, centroid)", 23.9670, 120.9770, "country"),
  P("Taiwan", "Taipei", 25.0330, 121.5654), P("Taiwan", "Kaohsiung", 22.6273, 120.3014),
  P("Taiwan", "Taichung", 24.1477, 120.6736), P("Taiwan", "Tainan", 22.9997, 120.2270),

  P("Malaysia", "COUNTRY (Ipoh, centroid)", 4.2105, 101.9758, "country"),
  P("Malaysia", "Kuala Lumpur", 3.1390, 101.6869), P("Malaysia", "George Town", 5.4141, 100.3288),
  P("Malaysia", "Johor Bahru", 1.4927, 103.7414), P("Malaysia", "Kota Kinabalu", 5.9804, 116.0735),

  P("Indonesia", "COUNTRY (Palangkaraya, centroid)", -2.2100, 113.9200, "country"),
  P("Indonesia", "Jakarta", -6.2088, 106.8456), P("Indonesia", "Surabaya", -7.2575, 112.7521),
  P("Indonesia", "Bandung", -6.9175, 107.6191), P("Indonesia", "Medan", 3.5952, 98.6722),

  P("Philippines", "COUNTRY (Mindoro, centroid)", 12.8797, 121.7740, "country"),
  P("Philippines", "Manila", 14.5995, 120.9842), P("Philippines", "Cebu City", 10.3157, 123.8854),
  P("Philippines", "Davao", 7.1907, 125.4553), P("Philippines", "Quezon City", 14.6760, 121.0437),

  P("UAE", "COUNTRY (Al Ain, centroid)", 24.2075, 55.7447, "country"),
  P("UAE", "Dubai", 25.2048, 55.2708), P("UAE", "Abu Dhabi", 24.4539, 54.3773),
  P("UAE", "Sharjah", 25.3463, 55.4209),

  P("Turkey", "COUNTRY (Kırşehir, centroid)", 39.1458, 34.1614, "country"),
  P("Turkey", "Istanbul", 41.0082, 28.9784), P("Turkey", "Ankara", 39.9334, 32.8597),
  P("Turkey", "Izmir", 38.4237, 27.1428), P("Turkey", "Bursa", 40.1826, 29.0665),

  P("Brazil", "COUNTRY (Brasília, centroid)", -15.7939, -47.8828, "country"),
  P("Brazil", "São Paulo", -23.5505, -46.6333), P("Brazil", "Rio de Janeiro", -22.9068, -43.1729),
  P("Brazil", "Belo Horizonte", -19.9167, -43.9345), P("Brazil", "Porto Alegre", -30.0346, -51.2177),

  P("Mexico", "COUNTRY (Aguascalientes, centroid)", 21.8853, -102.2916, "country"),
  P("Mexico", "Mexico City", 19.4326, -99.1332), P("Mexico", "Guadalajara", 20.6597, -103.3496),
  P("Mexico", "Monterrey", 25.6866, -100.3161), P("Mexico", "Puebla", 19.0414, -98.2063),

  P("Argentina", "COUNTRY (Córdoba, centroid)", -31.4201, -64.1888, "country"),
  P("Argentina", "Buenos Aires", -34.6037, -58.3816), P("Argentina", "Rosario", -32.9442, -60.6505),
  P("Argentina", "Mendoza", -32.8895, -68.8458),

  P("South Africa", "COUNTRY (Bloemfontein, centroid)", -29.0852, 26.1596, "country"),
  P("South Africa", "Cape Town", -33.9249, 18.4241), P("South Africa", "Johannesburg", -26.2041, 28.0473),
  P("South Africa", "Durban", -29.8587, 31.0218), P("South Africa", "Pretoria", -25.7479, 28.2293),

  P("Egypt", "COUNTRY (Asyut, centroid)", 27.1783, 31.1859, "country"),
  P("Egypt", "Cairo", 30.0444, 31.2357), P("Egypt", "Alexandria", 31.2001, 29.9187),
  P("Egypt", "Giza", 30.0131, 31.2089),

  P("Israel", "COUNTRY (centre)", 31.4117, 35.0818, "country"),
  P("Israel", "Tel Aviv", 32.0853, 34.7818), P("Israel", "Jerusalem", 31.7683, 35.2137),
  P("Israel", "Haifa", 32.7940, 34.9896),

  P("Russia", "COUNTRY (Kyzyl, centroid)", 51.7191, 94.4378, "country"),
  P("Russia", "Moscow", 55.7558, 37.6173), P("Russia", "Saint Petersburg", 59.9311, 30.3609),
  P("Russia", "Novosibirsk", 55.0084, 82.9357), P("Russia", "Kazan", 55.8304, 49.0661),
];

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

const key = (p) => `${p.country}|${p.name}`;

// GUIDE.md §5.6.1's verified query: `is_in` returns the areas CONTAINING the point.
// An `around:` query answers a different question and omits the enclosing country.
const query = (p) => `[out:json][timeout:90];
is_in(${p.lat},${p.lon})->.a;
area.a["boundary"="administrative"];
out tags;`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Overpass answers HTTP 200 with an HTML error body when busy (§D3), which resp.json()
// reports as a bogus parse error. Sniff the body before parsing so a busy endpoint is
// diagnosed as busy and retried, not recorded as a malformed response.
async function fetchOnce(endpoint, p) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      body: "data=" + encodeURIComponent(query(p)),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: ctl.signal,
    });
    const text = await resp.text();
    // 400 is a query bug, not congestion — retrying it just wastes calls forever.
    if (resp.status === 400) throw Object.assign(new Error(`HTTP 400 (fatal): ${text.slice(0, 200)}`), { fatal: true });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (!text.trimStart().startsWith("{")) throw new Error(`non-JSON body (endpoint busy): ${text.slice(0, 80).replace(/\s+/g, " ")}`);
    const json = JSON.parse(text);
    if (!Array.isArray(json.elements)) throw new Error("no elements array");
    return json.elements.map((e) => ({
      level: Number(e.tags?.admin_level),
      name: e.tags?.["name:en"] || e.tags?.name || "(unnamed)",
      type: e.tags?.admin_type || e.tags?.border_type || undefined,
    })).filter((e) => Number.isFinite(e.level));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchProbe(p) {
  let lastErr;
  for (const ep of ENDPOINTS) {
    try {
      const areas = await fetchOnce(ep, p);
      return { ok: true, areas, endpoint: new URL(ep).host, at: new Date().toISOString() };
    } catch (err) {
      lastErr = err;
      if (err.fatal) return { ok: false, error: err.message, fatal: true };
    }
  }
  return { ok: false, error: String(lastErr?.message || lastErr) };
}

// ---------------------------------------------------------------------------
// Cache + drive
// ---------------------------------------------------------------------------

function loadCache() {
  if (!existsSync(CACHE)) return {};
  try { return JSON.parse(readFileSync(CACHE, "utf8")); } catch { return {}; }
}
function saveCache(c) {
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(c, null, 2));
}

async function run() {
  const cache = loadCache();
  let outstanding = PROBES.filter((p) => !cache[key(p)]?.ok && !cache[key(p)]?.fatal);
  console.error(`${PROBES.length} probes; ${PROBES.length - outstanding.length} cached; ${outstanding.length} outstanding.`);

  for (let round = 1; round <= MAX_ROUNDS && outstanding.length; round++) {
    console.error(`\n--- round ${round}: ${outstanding.length} outstanding ---`);
    let got = 0;
    for (const p of outstanding) {
      const res = await fetchProbe(p);
      cache[key(p)] = { ...res, country: p.country, name: p.name, scale: p.scale, lat: p.lat, lon: p.lon };
      saveCache(cache); // save every probe — a crash mid-round must not lose the round
      if (res.ok) { got++; console.error(`  ok   ${key(p)} (${res.areas.length} areas)`); }
      else console.error(`  MISS ${key(p)}: ${res.error?.slice(0, 90)}`);
      await sleep(PAUSE_BETWEEN_MS);
    }
    outstanding = outstanding.filter((p) => !cache[key(p)]?.ok && !cache[key(p)]?.fatal);
    console.error(`round ${round}: +${got}, ${outstanding.length} still outstanding`);
    if (outstanding.length) await sleep(PAUSE_BETWEEN_ROUNDS_MS);
  }

  const done = PROBES.filter((p) => cache[key(p)]?.ok).length;
  console.error(`\nDONE: ${done}/${PROBES.length} resolved. Cache: ${CACHE}`);
  if (done < PROBES.length) {
    console.error("Unresolved:");
    for (const p of PROBES) if (!cache[key(p)]?.ok) console.error(`  ${key(p)}`);
  }
}

if (process.argv.includes("--report")) {
  const cache = loadCache();
  const done = PROBES.filter((p) => cache[key(p)]?.ok);
  console.error(`${done.length}/${PROBES.length} resolved.`);
} else {
  await run();
}
