# ui.js / vite.config.js modularization plan

Status: **follow-up** (P1 structural). This wave extracted
`GEV_REALTIME_TOOLS` (620 lines) from `vite.config.js` into
`src/voice/realtimeTools.js` and the radio tuner math into
`src/data/radioTunerMath.js`, plus the layer-module decoupling described in
docs/PERFORMANCE.md. The remaining splits below are mechanical but broad;
they are maintainability work, not performance work — the eager bundle is
already budgeted and gated.

## src/ui.js (456 KB / 10.3k lines)

Current shape: one unexported `CockpitViewController` (lines ~655–2110,
~1,455 lines) + `export class StyleManager` (~2112–10310, ~8,200 lines = 80%
of the file), plus ~60 imports and shared free helpers at ~199–653.

Recommended split order (lowest risk first):

1. **`src/cockpit/cockpitViewController.js`** — the controller is
   self-contained and wired only via one constructor call inside StyleManager
   (~2407). Move the class + its helper functions; re-import.
2. **`src/ui/radioPanel.js`** — the radio panel block (~5300–6110, ~810
   lines) is contiguous with weak coupling; convert methods to functions
   taking the style-manager context.
3. **`src/ui/cctvPanel.js`** — CCTV panel block (~6111–6690) + the panel
   storage-key helpers.
4. **`src/ui/contextMode.js`** — the context-mode engine (~4604–5299, ~695
   lines). Needs the three manager calls that are now public facades
   (`setEnabledWithIntent`, `waitForVisibilityIntent`).
5. **`src/ui/panelLayout.js`** — panel persistence & adaptive layout
   (~6690–7770, ~1,080 lines, biggest but most mechanical).
6. Location bar, facade setters, tickers/animation, share-button blocks.

The 644-line StyleManager constructor stays as the composed root. The
militaryAwareness/`formatAwarenessLabel` import already moved to
`militaryAwarenessEngine.js` (pure).

## vite.config.js (still ~310 KB after this wave)

Current shape: ~7,100 lines of proxy-middleware code + a 68-line config
factory at the end. The proxy code is one file purely by accretion; each
proxy is already a self-contained plugin factory with its own state and
helpers.

Recommended target:

```txt
config/proxy/
  _lib.mjs            rate limiters, single-flight coalescer, body readers
  overpass.mjs        + route proxy
  opensky.mjs         + OAuth token single-flight
  radio.mjs           + normalization helpers
  cctv.mjs            open-data loaders (Austin/Caltrans/TfL), synthetic SVG,
                      media proxying (~1,295 lines — the largest domain)
  aisStream.mjs       the ws-backed stream engine (~400 lines)
  realtime.mjs        OpenAI Realtime proxy + debug endpoints (imports
                      src/voice/realtimeTools.js)
  ...one file per upstream family
vite.config.js        imports + the 68-line defineConfig factory
```

Cross-file hazards to respect: module-level `let` cache state is interwoven
with each proxy's helpers (move it with its proxy), and
`PROVIDER_ENV_AT_BOOT` (globalThis-memoized at module load) must stay
evaluated at boot time — pass it into each factory rather than re-reading
`process.env` lazily.

## Why this matters (and why it didn't block this wave)

Huge single modules are hard to tree-shake, hard to code-split, and easy to
regress silently — the hud.js → gevActions.js import that re-eagered every
layer lived undetected for months precisely because the graph was opaque.
The new guards (dependency-cruiser boundary rules + the bundle budget gate)
make the graph visible; the splits above make each subsystem reviewable.
