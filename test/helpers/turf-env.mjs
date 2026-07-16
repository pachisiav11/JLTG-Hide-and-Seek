// src/tools.js reaches turf through `window.turf` (browser UMD bundle in vendor/).
// Node has no window, so load the vendored bundle and expose it the same way.
// Import this BEFORE importing anything from src/.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../../vendor/turf.min.js", import.meta.url), "utf8");

// Evaluate in an ISOLATED context with no `module`/`exports`, so the UMD wrapper always
// takes its globalThis branch and assigns `turf` on the sandbox. Running it in this
// context instead would be load-bearing on the caller's module system: under `node --test`
// (ESM) there is no `module` and it works, but under `node -e` (CJS) the wrapper takes the
// exports branch and never defines globalThis.turf.
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const loaded = sandbox.turf;
if (!loaded || typeof loaded.area !== "function") {
  throw new Error("vendor/turf.min.js did not expose a usable turf object");
}

globalThis.turf = loaded;
globalThis.window = globalThis.window || {};
globalThis.window.turf = loaded; // src/tools.js reads window.turf

export const turf = loaded;

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
