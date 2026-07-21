// Phase 35 (req #5): the "Location on" foreground indicator.
//
// A single clear chip shown to BOTH roles whenever any foreground GPS watch is
// active — an honest, always-visible "this app is using your location right
// now" signal. It reads the shared GeoWatch's active state (Phase 36), so it
// covers the geofence, the seeker publisher, AND the always-on self-dot without
// knowing about any of them. On the seeker's Android device the OS
// foreground-service notification (Phase 42) is the system-level equivalent;
// this chip is the in-app version.
//
// It mounts into the shared pill stack (Phase 29), so it stacks cleanly with the
// geofence / live-share pills and can be dismissed like them (dismiss hides the
// chip only — the watch keeps running).

import { geoWatch } from "./geo-watch.js";
import { createPill } from "./pill-stack.js";

export class GpsStatus {
  constructor({ watch = geoWatch } = {}) {
    this.watch = watch;
    this._unsub = null;
    this._pill = null;
  }

  init() {
    // onActiveChange fires immediately with the current state, so the chip is in
    // sync from the moment it mounts.
    this._unsub = this.watch.onActiveChange((active) => this._render(active));
  }

  destroy() {
    this._unsub?.();
    this._unsub = null;
    this._removePill();
  }

  _render(active) {
    if (active) {
      if (!this._pill) {
        this._pill = createPill({ id: "gps-status-pill", variant: "gps" });
        this._pill?.setText("📍 Location on");
      }
    } else {
      this._removePill();
    }
  }

  _removePill() {
    this._pill?.remove();
    this._pill = null;
  }
}
