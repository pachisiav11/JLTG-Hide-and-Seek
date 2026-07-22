# Phase 40 results — the Doze spike verdict

Recorded per [`PHASE40_DOZE_SPIKE.md`](./PHASE40_DOZE_SPIKE.md). Device: **OPPO
CPH2585** (ColorOS 16, Android SDK 36, build `CPH2585_16.0.5.702(EX01)`).

Both runs forced Doze with `adb shell dumpsys deviceidle force-idle`, screen
off, verified `mState=IDLE` before starting the walk, and released it with
`unforce` + `battery reset` afterward. Battery mode was **Smart** (ColorOS's
default/automatic app battery management) for both runs — it was never
switched to "Allow background activity"; the only variable that changed was
the AOSP `deviceidle` whitelist.

| | Run 1 | Run 2 |
| --- | --- | --- |
| AOSP Doze whitelist | app added (`+com.pachisiav11.jltg`) | app removed |
| ColorOS battery mode | Smart (default) | Smart (default) |
| Forced Doze state | `IDLE` | `IDLE` |
| Fixes collected | 799 | 800 |
| Max inter-fix gap | 7.5 s | 3.5 s |
| Gaps > 15 s | 0 | 0 |
| Run duration | ~13 min | 12.35 min |
| Geofence crossing notification | ✅ fired ("Back inside the hiding zone") | not exercised (walk didn't re-enter the zone) |
| Verdict | **PASS** | **PASS** |

## Reading

Run 2 is the more aggressive condition — off the whitelist, deep Doze, default
OEM battery management — and it performed *better* than Run 1 (tighter max
gap, one more fix). This rules out the AOSP Doze whitelist and ColorOS's own
battery restriction as limiting factors on this device: the
`@capacitor-community/background-geolocation` **foreground service** (backed
by the persistent notification) keeps the watcher alive through Doze
regardless.

Both independent signals agree with a **PASS**: the gap analysis stayed far
under the 120 s failure threshold in both runs, and Run 1's live crossing
notification landed inside the forced-Doze window with a correct timestamp.

## Decision for Phase 41

**PASS → the hider geofence rides the free foreground-service path.** Compute
the band in JS with the existing `evaluateGeofence`, fire the alert via
`@capacitor/local-notifications`. No native OS geofencing or FCM required for
this device/OEM combination. Phase 41 folds the two manual `AndroidManifest.xml`
edits from Phase 40 into the committed native config and builds the real hider
flow on top of `src/bg-spike.js`'s proven pattern.
