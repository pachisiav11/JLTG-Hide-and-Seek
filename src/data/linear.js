// Bundled linear-feature geometry for the Measuring tool (guide §5.4, §11).
// Linear features (coastline, rail) can't come from the Places API, so a small
// dataset ships with the app for the supported play zones.
//
// NOTE: these polylines are hand-traced APPROXIMATIONS of the Mumbai western
// shoreline and Western Railway line — good enough for demonstrating distance
// buffers, but not survey-accurate. Refine or add zones by editing this file.
// Coordinates are GeoJSON order: [lng, lat].

export const LINEAR_FEATURES = [
  {
    id: "coastline_mumbai_west",
    name: "Mumbai west coastline (approx)",
    geojson: {
      type: "LineString",
      coordinates: [
        [72.8110, 19.1370],
        [72.8180, 19.1240],
        [72.8250, 19.1130],
        [72.8262, 19.1060],
        [72.8265, 19.0980],
        [72.8280, 19.0900],
        [72.8300, 19.0820],
        [72.8250, 19.0720],
        [72.8210, 19.0640],
        [72.8195, 19.0540],
        [72.8200, 19.0450],
      ],
    },
  },
  {
    id: "western_railway_approx",
    name: "Western Railway line (approx)",
    geojson: {
      type: "LineString",
      coordinates: [
        [72.8470, 19.1280],
        [72.8460, 19.1190],
        [72.8450, 19.1000],
        [72.8410, 19.0810],
        [72.8400, 19.0700],
        [72.8400, 19.0600],
        [72.8405, 19.0540],
      ],
    },
  },
];

export function findLinearFeature(id) {
  return LINEAR_FEATURES.find((f) => f.id === id) || null;
}
