// Named-region boundary lookup for building play zones (e.g. "Singapore",
// "Switzerland"). Uses OpenStreetMap Nominatim, which — unlike Google's geocoder —
// returns real administrative-boundary polygons (polygon_geojson=1), not just a
// bounding box. Falls back to the bounding box when no polygon exists.
//
// Nominatim usage policy: low volume only, no heavy/bulk use. Fine for a personal
// planning tool. Results are CORS-enabled.

const ENDPOINT = "https://nominatim.openstreetmap.org/search";

export async function searchRegions(query) {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    polygon_geojson: "1",
    limit: "8",
    addressdetails: "0",
  });
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Region search failed (HTTP ${res.status}).`);
  const data = await res.json();
  return data.map((d) => ({
    name: d.display_name,
    shortName: (d.display_name || "").split(",")[0].trim(),
    kind: `${d.type || ""}${d.class ? " · " + d.class : ""}`,
    geojson: d.geojson || null,
    boundingbox: d.boundingbox || null, // [south, north, west, east] as strings
  }));
}

// Convert a Nominatim result into an array of zone rings ([[lat,lng],...]).
// Polygon/MultiPolygon → outer rings; otherwise a rectangle from the bounding box.
export function regionToRings(result) {
  const g = result.geojson;
  if (g && (g.type === "Polygon" || g.type === "MultiPolygon")) {
    const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    const rings = [];
    for (const poly of polys) {
      if (poly[0]) rings.push(poly[0].map(([lng, lat]) => [lat, lng]));
    }
    if (rings.length) return rings;
  }
  // Fallback: bounding-box rectangle.
  if (result.boundingbox) {
    const [s, n, w, e] = result.boundingbox.map(Number);
    return [[[s, w], [s, e], [n, e], [n, w]]];
  }
  return [];
}
