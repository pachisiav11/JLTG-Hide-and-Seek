// src/tools.js reaches turf through `window.turf` (browser UMD bundle in vendor/).
// Node has no window, so load the vendored bundle and expose it the same way.
// Import this BEFORE importing anything from src/.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../../vendor/turf.min.js", import.meta.url), "utf8");
// No `module`/`exports` in this scope, so the UMD wrapper assigns globalThis.turf.
vm.runInThisContext(code);

if (!globalThis.turf) throw new Error("vendor/turf.min.js did not expose globalThis.turf");
globalThis.window = globalThis.window || {};
globalThis.window.turf = globalThis.turf;

export const turf = globalThis.turf;

// A square game area centred on `center`, `sizeDeg` on a side.
export function squareArea(center = [72.8777, 19.076], sizeDeg = 0.2) {
  const [x, y] = center;
  const h = sizeDeg / 2;
  return {
    type: "Polygon",
    coordinates: [[
      [x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h], [x - h, y - h],
    ]],
  };
}

// A radar step. side "out" eliminates the circle's interior; "in" eliminates outside it.
export function radarStep({ center = [72.8777, 19.076], radiusM, side, enabled = true, id = "s1" }) {
  return {
    id, tool: "radar", enabled,
    inputs: { center: { lng: center[0], lat: center[1] }, radius: radiusM },
    answer: { side },
  };
}
