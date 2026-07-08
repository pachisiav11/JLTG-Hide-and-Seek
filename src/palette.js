// Colour palette (Phase 7). The whole elimination model communicates state through
// fill/stroke colour, so an accessible alternative palette is high-value: a toggle
// (persisted in localStorage) swaps every active shaded layer + guide between the
// default vivid palette and an Okabe-Ito / Paul-Tol colour-blind-safe one instantly,
// with no re-fetch. Modules read getPalette() on each render and re-render when the
// `jltg:palette` window event fires.

const LS_KEY = "jltg.palette";

// mask (the dark "everything outside the play area" fill) stays constant in both
// themes — it's a neutral dark, never a hue that needs to be told apart.
const MASK = { fillColor: "#020a0c", fillOpacity: 0.55 };

const THEMES = {
  // Default vivid palette (the original look).
  default: {
    mask: MASK,
    active: "#34d399",       // remaining-area outline (green)
    guide: "#38bdf8",        // default guide stroke (sky)
    faintOutline: "#94a3b8", // incidental Voronoi cell edges
    zone: "#2dd4bf",         // drawn zone fill/stroke
    area: "#f2c14e",         // assembled game-area boundary
    // Per-question guide cycle: two open questions of the same tool must be
    // visually distinguishable, so each enabled step draws in the next colour.
    steps: ["#38bdf8", "#f472b6", "#a3e635", "#fb923c", "#c084fc", "#22d3ee", "#facc15", "#f87171"],
  },
  // Okabe-Ito colour-blind-safe palette (black swapped for a light grey so it
  // reads on the dark mask). Distinguishable across the common CVD types.
  cb: {
    mask: MASK,
    active: "#009E73",       // bluish green
    guide: "#56B4E9",        // sky blue
    faintOutline: "#BBBBBB",
    zone: "#009E73",
    area: "#E69F00",         // orange
    steps: ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#DDDDDD"],
  },
};

export function getPaletteName() {
  const n = (typeof localStorage !== "undefined" && localStorage.getItem(LS_KEY)) || "default";
  return THEMES[n] ? n : "default";
}

export function getPalette() {
  return THEMES[getPaletteName()];
}

// Persist + broadcast so live overlays restyle immediately (no re-fetch).
export function setPalette(name) {
  const valid = THEMES[name] ? name : "default";
  try { localStorage.setItem(LS_KEY, valid); } catch (_) {}
  if (typeof window !== "undefined") window.dispatchEvent(new Event("jltg:palette"));
  return valid;
}
