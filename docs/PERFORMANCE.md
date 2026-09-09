# Performance baseline

This page records one hardware-rendered Apple M5 comparison captured on 22
August 2026 in Chrome 150 at 1440 x 900. It is not a minimum hardware
specification and should not be used to predict performance on untested systems.
The original capture artifacts are not included here, so this page records
results rather than defining a runnable benchmark.

## Test context

The baseline was captured on 22 August 2026 with these conditions:

| Setting | Value |
| --- | --- |
| Renderer | Apple M5 Metal through the hardware ANGLE path |
| Browser | Chrome 150 in a fresh isolated profile |
| Viewport | 1440 x 900 at device pixel ratio 1 |
| Focus | Page foregrounded for controlled scenes |
| Scene sample | 5 seconds of scripted motion, then 5 seconds at rest |
| Startup | Browser cache disabled; three samples |

The capture covered three startup samples, 16 cold layer scenarios with 14
measurements, 23 controlled option and stress scenes, and five
hardware-rendered overlay scenes.

## Startup

| Sample | App ready | Initial settle | Load event | Motion / rest | Used JS heap |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 784.980 ms | 2,035.082 ms | 439.5 ms | 60 / 60 FPS | 102.9 MiB |
| 2 | 604.849 ms | 1,855.836 ms | 442.4 ms | 60 / 60 FPS | 111.6 MiB |
| 3 | 558.527 ms | 1,809.592 ms | 438.8 ms | 60 / 60 FPS | 105.1 MiB |
| Median | 604.849 ms | 1,855.836 ms | 439.5 ms | 60 / 60 FPS | 105.1 MiB |

The initial-settle measurement is the more useful launch reference because it
includes the first visual and data settling window. All three samples reached
the display ceiling during both motion and rest.

## Cold layer activation

Cold activation was measured separately from warm option switching. Live object
counts are included so that future runs can compare source populations before
attributing a difference to the client.

| Layer | Activation | Source count | Motion / rest | Used JS heap |
| --- | ---: | ---: | ---: | ---: |
| CCTV city | 19,608.240 ms | 48 | 60 / 60 FPS | 192.7 MiB |
| Space Missions (report label: Rocket missions) | 3,581.066 ms | 26 | 60 / 60 FPS | 131.3 MiB |
| Radio | 3,458.709 ms | 750 | 60 / 60 FPS | 124.8 MiB |
| Bikeshare | 2,069.498 ms | 633 | 60 / 60 FPS | 157.4 MiB |
| Datacenters | 817.693 ms | 4,362 | 59.6 / 60 FPS | 328.2 MiB |
| Flights | 667.671 ms | 247 | 60 / 60 FPS | 118.4 MiB |
| Submarine cables | 614.727 ms | 2,629 | 60 / 60 FPS | 412.0 MiB |
| Military Flights | 557.113 ms | 68 | 60 / 60 FPS | 118.4 MiB |

CCTV had the largest cold activation cost in this capture. Submarine cables
used the most heap, followed by datacenters. Completed single-layer samples
generally reached 60 FPS, so activation time and heap separate these cases more
clearly than steady-state frame rate.

## Aircraft, detection, and Cockpit

| Scene | Motion / rest |
| --- | ---: |
| Idle globe | 60 / 60 FPS |
| Flights, 2D | 60 / 60 FPS |
| Flights, 3D proximity | 60 / 60 FPS |
| Flights, all 3D models | 60 / 60 FPS |
| Military Flights, all 3D models | 60 / 60 FPS |
| Detection at 25% | 39.3 / 41.1 FPS |
| Detection at 50% | 37.4 / 39.8 FPS |
| Detection at 100% | 34.4 / 35.5 FPS |
| Cockpit | 49.6 / 49.2 FPS |

The clean detection scenes processed 8,169 to 8,170 observations. Selected
labels rose from 14 at 25% density to 28 at 50% and 56 at 100%. The aircraft
rows came from an earlier loaded, foreground-controlled pass because the clean
rerun received no live aircraft rows.

## Visual styles and combined stress

| Scene | Motion / rest |
| --- | ---: |
| Normal | 60 / 60 FPS |
| CRT (report label: Retro) | 60 / 60 FPS |
| NVG (report label: Surveillance) | 60 / 60 FPS |
| FLIR (report label: Thermal) | 49 / 60 FPS |
| Anime | 60 / 59.8 FPS |
| Noir | 47 / 56.6 FPS |
| Snow | 42.3 / 45.8 FPS |
| Combined static | 57.6 / 60 FPS |
| Combined operational | 39.9 / 43.1 FPS |

The combined static scene rendered 11,575 objects, used 872.2 MiB of JavaScript
heap, and issued 48,665 text draws during motion and 54,106 at rest. The combined
operational sample contained 3,909 observations and two selected labels, but its
live aircraft and traffic rows were empty, so it remains a limited stress case.

Snow, Noir, dense detection, and text-heavy combined layers are the clearest
controlled comparison points for later optimization work.

## Keyed live sources

NASA FIRMS, AISStream, and TomTom were captured in a separate hardware-rendered
pass. The page was visible but was not the focused window, so these frame rates
must not be compared directly with the foreground-controlled scenes above.

| Source | Point-in-time population | Activation or coverage | Motion / rest |
| --- | ---: | --- | ---: |
| NASA FIRMS | 100,430 detections in 3,557 cells | 30.0 s activation | 32.1 / 55.2 FPS |
| AISStream | 12,000 vessels | 6.4 s activation | 22.1 / 29.8 FPS |
| TomTom Traffic | 4,222 road dots | 70% coverage, 2 decoded tiles | 45.0 / 51.7 FPS |

These populations change continuously. A future comparison must record the
live counts again and match the focus conditions.

## Controls for a future capture

Use the same controls before attributing a difference to the application:

1. Record the exact GPU renderer and reject software-rendered or unavailable GPU
   strings.
2. Use a 1440 x 900 viewport at device pixel ratio 1 and keep the page focused.
3. Measure cache-disabled startup separately from cold layer activation and warm
   option switching.
4. Repeat startup three times and compare medians.
5. Sample each option for 5 seconds in scripted motion and 5 seconds at rest.
6. Record live object counts before attributing a difference to the client.
7. Treat a live-source outage as missing coverage, not as evidence of low client
   rendering cost.

## What is not established yet

- This report does not establish Windows performance.
- The report does not record machine memory capacity, so it cannot support a
  minimum-memory recommendation.
- The report does not cover other GPU renderers or viewport configurations.
- Military Installations is outside this comparison because it requires close
  camera context.
- The keyed pass has no controlled rerun suitable for comparison with the
  option scenes.

Use this page as a regression baseline for one known hardware and browser
configuration, not as a compatibility guarantee.


## 2026-09 performance wave — boot, adaptive quality, scheduler, caches

This wave changed WHEN JavaScript loads, how much per-frame GPU work the
pipeline claims, and how polls coordinate — not the renderer itself. The
Cesium + vanilla JS architecture is unchanged, as intended.

### Boot bundle (measured on the production build)

| Metric | Before | After |
| --- | ---: | ---: |
| Eager JS (gzip) | 422.6 kB | 198.2 kB |
| Entry chunk (raw) | 1,369.3 kB | 662.5 kB |
| Layer modules parsed at boot | 17 of 17 | 0 (lazy per enable) |
| Voice + annotations + scenes at boot | eager | deferred to post-paint idle |

How: lazy layer registration (`src/data/layerManifest.js` +
`DataLayerManager.registerLazy`), live-forwarding layer accessors
(`src/data/layerAccess.js`) so ui.js no longer statically imports every layer,
a lazy basemap-context import in hud.js (this one import was pulling the whole
voice graph into the eager chunk), and manualChunks for the geo math family.

The budget is now enforced: `scripts/check-bundle-budget.mjs` fails any PR
that grows the initial chunk more than 50 kB gzip over the committed baseline
(`config/bundle-budget.json`).

### Fixed GPU costs made adaptive

- `preserveDrawingBuffer` is now `false` (was `true`). The only Cesium-canvas
  consumer — voice viewport capture — already reads inside its postRender task
  via `renderFreshCesiumFrame()`, which is the capture-safe pattern without
  buffer preservation. All other `toDataURL`/`getImageData` sites use their
  own offscreen 2D canvases.
- `msaaSamples` starts at 1× on the low-end profile (else 4×) and steps with
  the adaptive quality tier (`src/quality/adaptiveQuality.js`): FPS sampled
  from `scene.postRender` timestamps, resolution 1.0 → 0.85 → 0.75, MSAA
  4/2/1, with hysteresis (3 bad windows to demote, 6 good to promote) and a
  5 s cooldown.
- Low-end profile detection: `?profile=low` / `?profile=high` override;
  otherwise <6 GB deviceMemory, ≤4 logical cores, or phone UA.
- Detection label budgets scale by tier (`getLabelBudgetScale()`): the
  stress scenes below (dense detection, Snow, combined operational) draw
  fewer labels on constrained hardware instead of dropping frames.

### Polling architecture

Manager-owned refresh intervals moved from one raw `setInterval` per layer to
a shared scheduler (`src/data/feedScheduler.js`): jittered cadence (no
enable-time thundering herd), exponential backoff to a cap on failing
providers with recovery after 2 successes, visibility pause (hidden tabs poll
for nobody), and no overlapping ticks. Keyless GET feeds (USGS, Launch
Library 2, GBFS) read through a staleness-aware cache
(`src/data/feedCache.js`): TTL + ETag revalidation + serve-stale-on-failure,
so a provider outage presents as stale data, not a blank layer.

### Burst-toggle crash class (PR #141)

Two cooperating fixes, both in the application layer (no head-patch script):
the idle render governor coalesces same-frame requestRender storms, and
user-origin toggle clicks serialize through a latest-wins FIFO with bounded
concurrency and an 80 ms dispatch gap. All 104 DataLayerManager event
choreography tests pass unchanged in behavior.

### What this wave did NOT change (deliberately)

- No WebGPU, no Wasm SGP4, no binary protocols, no hosted relay — those stay
  profiling-gated decisions per the roadmap.
- The entity-vs-primitive audit found flights already on a batched
  BillboardCollection, detection on a Canvas2D overlay with a label arbiter,
  and satellites already cursor-amortized: the measured hot paths were
  already primitive-based; the remaining wins were boot weight, fixed GPU
  cost, and burst handling.
- Submarine cables / datacenters still parse to object graphs at activation
  (the documented heap numbers): the tiled/binary conversion remains the
  known next milestone for heap reduction.

## 2026-09 MILLION-X wave 2 — bus, provenance, timeline, relevance, feed health

Five architecture primitives shipped in one wave (see CHANGELOG for the full
contract). Performance-relevant facts, measured on the production build:

### Eager-bundle impact

| Metric | Wave 1 | Wave 2 | Delta |
| --- | --- | --- | --- |
| Eager JS (gzip) | 198.9 kB | 200.3 kB | +1.4 kB |
| Eager total (JS+CSS, gzip) | 231.1 kB | 232.4 kB | +1.3 kB |

The entire delta is `src/data/feedHealth.js` (~1.4 kB gzip) entering the eager
graph through `manager → feedScheduler → feedHealth` — the breaker must be live
before the first poll fires. The other four modules are imported only by the
lazily-loaded earthquakes layer, and the debug facade reaches them via dynamic
import getters (`__godsEyeView.bus/.timeline/.feedHealth`), so they cost boot
nothing.

### Runtime cost profile

- **Event bus**: synchronous dispatch is a Set walk (sub-millisecond for the
  current subscriber count); replay buffers are bounded (32 events/channel)
  and burst coalescing merges same-key publishes in the buffer. The timeline
  ring is capacity-bounded (2,048 events) with snapshot compaction every 24
  deltas per layer, so `stateAt()` stays O(deltas since snapshot).
- **Provenance**: pure record minting at poll boundaries (once per 60 s for
  earthquakes), WeakMap attachment on entities — no per-frame cost, no
  serialization impact, ledger capped at 2,048 identities.
- **Relevance**: scoring happens once per poll on the label cohort (≤96
  entries), not per frame; the detection label budget path is untouched.
- **Feed health**: EWMA updates are O(1) per tick; the breaker gate is a state
  read. When a circuit is OPEN the scheduler skips the network call — on a
  dead provider the wave strictly REDUCES work.

### Test coverage

97 new tests (eventBus 18, provenance 15, eventStore 19, relevance 19,
feedHealth 15, earthquakes integration 8, scheduler breaker 4 — totals per
module file). Full suite: 2,832 pass / 0 fail / 1 skip (was 2,735 pass).
Lint: 0 errors, 88 warnings (unchanged from baseline — the wave adds no new
warnings). depcruise: 0 violations. Smoke gate: 4/4. Budget gate: PASS.
