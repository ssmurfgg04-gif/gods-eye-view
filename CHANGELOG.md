# Changelog

## [Unreleased] — Performance & hardening wave ("stop the browser crashing")

One focused pass over boot cost, render-cost adaptivity, polling architecture,
feed resilience, and the crash class reported in PR #141. **No features were
removed** — every change is a pure performance, robustness, or boundary fix.

### Boot & bundle (P0)
- **Lazy layer registration** (`src/data/layerManifest.js`,
  `DataLayerManager.registerLazy`): the 17 layer implementations are no longer
  statically imported at boot; each loads on first enable/restore. Eager JS
  dropped from ~423 kB to ~198 kB gzip (−53%), entry chunk 1,369 kB → 662 kB.
- **Deferred voice/annotations/scenes subsystem**: the OpenAI Realtime stack,
  annotation engine, and scene director stream in after first paint (idle) or
  first interaction instead of competing with boot.
- **Layer accessors** (`src/data/layerAccess.js`): ui.js calls into layers
  through live-forwarding proxies, so no layer module is statically reachable
  from the boot graph (`hud.js` basemap context import made lazy for the same
  reason).
- **manualChunks**: the geo math family (satellite.js/pbf/vector-tile/mgrs)
  splits into its own long-lived chunk; `egm96` deliberately stays lazy.
- **Bundle budget gate**: `scripts/check-bundle-budget.mjs` +
  `.github/workflows/bundle-budget.yml` fail a PR that grows the initial chunk
  more than 50 kB gzip over `config/bundle-budget.json`.

### Render cost (P0)
- **`preserveDrawingBuffer: false`** (was `true`): the only Cesium-canvas
  consumer (voice viewport capture) already reads inside its postRender task,
  which is the capture-safe pattern; every other capture site uses its own
  offscreen canvas. Removes the forced extra buffer copy on every frame.
- **Adaptive quality** (`src/quality/adaptiveQuality.js`): FPS-sampled
  resolution/MSAA tiering (1.0/4× → 0.85/2× → 0.75/1×) with hysteresis and
  cooldowns, driven by `scene.postRender` timestamps.
- **Low-end profile**: `?profile=low`, `<6 GB deviceMemory`, ≤4 cores, or
  phone UA starts at the reduced tier; detection/label budgets scale down via
  `getLabelBudgetScale()` (the PERFORMANCE.md stress scenes showed label churn
  as the top FPS cost).

### Crash & burst fixes (PR #141)
- **Render-request coalescer** in the idle render governor: the first request
  in a frame forwards synchronously, same-frame repeats collapse into one
  deferred flush — a toggle burst costs at most two scene requests per frame
  instead of dozens.
- **User-toggle burst queue** (`_queueUserToggle`): rapid multi-row toggle
  sweeps dispatch with latest-wins dedup, bounded concurrency, and an 80 ms
  gap. Programmatic/voice/restore flows keep their exact direct paths (all 104
  manager choreography tests unchanged in behavior, updated only for the
  interval→feed-job field rename).

### Polling & feeds (P1)
- **Shared feed scheduler** (`src/data/feedScheduler.js`): manager-owned
  periodic refreshes now run with jittered cadence (no enable-time thundering
  herd), exponential backoff on failing providers, visibility pause, and
  no-overlap ticks — replacing one raw `setInterval` per layer.
- **Staleness-aware feed cache** (`src/data/feedCache.js`): TTL + ETag
  revalidation + serve-stale-on-failure for keyless GET feeds. Wired into
  Earthquakes, Space Missions (Launch Library 2), and GBFS Bikeshare; Radio
  already had proxy-level stale semantics. A provider outage now reads as
  "slightly old data" instead of a blank layer.
- **PR #198 (earthquakes)**: snapshots are fully validated (coordinates,
  magnitude, ranges) BEFORE replacing the live entity set — a malformed
  feature can no longer blank the layer mid-replace.
- **PR #180 (GBFS proxy)**: upstream redirects are refused outright (allowlist
  bypass closed) and the 5 MB body cap is enforced while streaming, not only
  after buffering.

### Boundaries & hygiene (P1/P2)
- **Public manager facades**: `setEnabledWithIntent`, `waitForVisibilityIntent`,
  `requestPanelRefresh`, `consumePanelRefreshPendingOnVisible` replace every
  cross-module private-field reach (main.js, ui.js, gevActions.js). An ESLint
  `no-restricted-syntax` rule blocks new reach-throughs.
- **GEV_REALTIME_TOOLS extracted** to `src/voice/realtimeTools.js` (620 lines
  of pure schema data out of vite.config.js; also smoke-tested in CI).
- **LAN share session token** (SECURITY): `/api/*` gated behind a per-boot
  token when bound to the LAN; loopback unchanged; documented in SECURITY.md.
- **Fast PR gate**: `scripts/smoke-pr-gate.mjs` (module loads, tool schema
  validation, manifest/registry match, manager lifecycle round-trip) + ESLint
  (flat config) + dependency-cruiser boundary rules, wired into ci.yml.
- **New unit tests**: feedScheduler, feedCache, layerAccess, layerManifest,
  adaptiveQuality (29 tests).

### Verified
- `npm test` full suite, `npm run lint` (0 errors), `depcruise` (0 violations),
  smoke gate (4/4), `npm run build` + bundle budget gate PASS.


This changelog records public product changes. For the authoritative description
of current runtime behavior, see [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md).

## [Unreleased]

### Fixed

- Mapped-site outages show their scheduled retry countdown and distinguish
  known Overpass rate limits, timeouts, and query failures. Search feedback no
  longer claims a refresh succeeded while the layer is unavailable or loading.
- Mapped installations retain valid ways and relations that provide bounds but
  no center. Invalid, inverted, and excessively wide bounds are rejected.
- Clicking a selected installation again or clicking elsewhere clears its
  selection; later refreshes no longer reclaim it after a click-away.
- Visual presets explain their effects on hover. Unavailable map sources name
  missing credentials and Provider Settings, while configured-but-failed
  Google 3D routes explain the failure without asking for another key.

- The Overpass proxy now rotates to the next mirror on any non-2xx upstream
  response, not only on 5xx. `overpass-api.de` and its `lz4` alias answer 406 to
  the proxy's User-Agent while two of the configured mirrors answer 200 to the
  identical request, so the fan-out stopped at the first refusal with healthy
  mirrors untried. The refusal was also cached to memory and disk and served as
  data — boundary-class queries hold a month-long TTL — which affected every
  Overpass-backed feature: road geometry, annotation outlines and place lookup.
- Existing cached refusals are now ignored immediately, including during
  stale-data fallback. Concurrent identical requests share the same last-good
  fallback when all mirrors refuse, without duplicating upstream requests.

## [0.1.1] — 2026-09-01 — Installation and live-data fixes

### Changed

- Tightened the README opening around keyless setup, source freshness, modeled
  experiences, and the accessibility of the provider stack.

### Fixed

- Pinokio now recognizes its nested successful-install marker, so a completed
  one-click install exposes Start instead of returning to Install.
- The keyless `dev-fresh.sh` startup summary now names Esri World Imagery with
  keyless terrain and identifies OpenStreetMap as the fallback.
- All three VIIRS sources now reach the Active Fires layer. Merging a source's
  detections used argument spread, which exceeds the engine's argument limit on
  the two largest sources and dropped them entirely — leaving roughly a third of
  global detections while reporting each dropped source twice, once as
  successful with its real count and once as failed.
- `./scripts/dev-fresh.sh` no longer crashes on stock macOS bash 3.2 when no
  provider keys are exported: expanding the empty external-keys provenance
  array under `set -u` was fatal there. Launches with exported keys are
  unchanged.

### Security

- GBFS proxy body-size cap now measures the response in bytes
  (`Buffer.byteLength`) instead of JavaScript string length, so the
  `GBFS_MAX_BODY_BYTES` limit holds for multi-byte payloads and cannot be
  overrun by non-ASCII upstream responses.

## [0.1.0] — 2026-08-31 — One-click install, keyless boot, Provider Settings

### Added
- **One-click install** via Pinokio. Keyless boot lands on a live Esri World
  Imagery satellite globe with keyless terrain; OSM takes over automatically if
  Esri is unreachable, and the globe continues without terrain if its source is
  unavailable.
- **Provider Settings** (the POWER UP panel): add, replace, or remove API keys
  inside the app. Credential files are made owner-only before any secret is
  written — verified on macOS and Windows — and keys configured outside the
  panel are shown read-only, never rewritten.
- **Keyless capability responses**: the optional HUD summary and place-search
  endpoints return a deliberate "not configured" success instead of errors, and
  never consume rate-limit quota.
- `.gitattributes` normalizes line endings, so Windows clones pass the full
  test suite out of the box (#81 — thanks @ethanstoner).

### Changed
- README rewritten keyless-first around the provider ladder: zero keys → free
  Cesium ion (eligible personal, non-commercial use) → billing-enabled Google
  Maps.
- Browser-built data modules no longer import `node:fs`; a repo-wide boundary
  scan test keeps it that way (#83 — thanks @ethanstoner).
- Aircraft-identity voice answers explicitly cover operator, type, and route,
  and say so plainly when enrichment is unavailable instead of guessing.

### Security
- Provider Settings answers only local, unproxied requests and disables itself
  entirely whenever the server is shared. Public datacenter and dam datasets
  omit contact-oriented fields (see the dataset READMEs).

## Pre-release development history

The dated entries and internal milestone numbers below predate the first
tagged GitHub Release. They are retained as project history and do not
represent previously published GitHub Releases.

## [Unreleased] — 2026-08-24

### Added

- Added honest aircraft identity narration: callsign, operator, registration,
  type, and route come only from selected-contact context, and missing operator,
  route, or type enrichment is named explicitly.
- Added local, publication-compatible copies of the two README PNGs, with source
  records and third-party-license boundaries in `docs/media/README.md`.
- Added regression coverage for aircraft identity narration and optional-key
  loading feedback.

### Changed

- First-run presentation now opens with Detection `DENSE` at 75%, `ELASTIC`
  allocation, Fade 7%, Outside 1%, scope feather 11%, and aircraft 3D models in
  `PROXIMITY`. Stored state and share links still override these baselines.
- The 17 selected README GIFs remain unchanged and are documented separately
  from the two owner-published PNGs.
- Bundled datacenter and dam snapshots now omit contact-oriented fields and
  note values containing email or phone identifiers. Feature geometry, names,
  operator/capacity/river metadata, counts, and ODbL terms are unchanged.
- Public documentation and the L9 release matrix no longer reference non-public
  planning material or repository history.

### Fixed

- A missing optional FIRMS key no longer turns the complete Environmental
  mission into `LOAD FAILED`. The FIRMS row still reports `KEY REQUIRED`, while
  earthquakes continue to load. Real lifecycle and fetch failures retain
  failure priority.
- The mapped-installations layer retries after an unavailable request when it is
  enabled or the camera settles.
- Aircraft trails attach to the rendered aircraft transform and remain near the
  rear center across headings. Parked aircraft do not draw a moving head
  segment.
- Grounded aircraft keep validated floor evidence through temporary terrain
  outages and wait for measured photoreal-surface evidence before a 3D model
  takes over from its billboard.
- Cockpit altitude uses aviation MSL data rather than Cesium render height.

### Security

- Production transitive dependencies resolve to patched DOMPurify and
  protobufjs releases without changing the Cesium version or application APIs.
- Production dependency audit reports no known advisories; remaining audit
  findings are confined to development and QA tooling.

## [Unreleased] — 2026-08-23

### Added

- Added a first-run mission launcher for Contacts, Space Missions,
  Environmental, and manual exploration.
- Added terrain-validity gating and bounded last-known placement for grounded
  aircraft models.

### Changed

- Environmental consistently presents both earthquakes and NASA FIRMS fires,
  with honest optional-key degradation.
- The tracked aircraft trail acceptance bar is visual: roughly rear-center,
  stable across headings, with minor hull overlap allowed and no conspicuous
  top, bottom, or lateral projection.

## [Unreleased] — 2026-08-18 to 2026-08-22

### Added

- Added the four-source Map Source tray, share-link v2 state, cockpit/context
  voice parity, MSL altitude readouts, and close-range tracked aircraft models.
- Added the L9 release-candidate matrix, AIS feed watchdog, voice cost controls,
  satellite classes, and the shared world-overlay host.
- Added deterministic first-run, map-source, floor, overlay, tracking, and
  aircraft-model regression harnesses.

### Changed

- Consolidated world labels, cards, tracked readouts, CCTV thumbnails, cable
  labels, mission labels, and detection presentation under shared allocation and
  lifecycle rules.
- Reduced idle rendering through the render governor and explicit scope mask.
- Improved cockpit layout, context restoration, keyless feed honesty, and
  aircraft 2D/3D handoffs.

### Fixed

- Fixed degenerate depth picks, map-source restore states, route-camera motion,
  bright-ground label readability, grounded display flooring, and cross-layer
  tracking cleanup.
- Fixed stale overlay callbacks, parked-idle render leaks, cable-label sweep
  starvation, and several share-link state conflicts.

## [Unreleased] — 2026-08-02 to 2026-08-16

### Added

- Added Global Context modes, Cockpit briefing surfaces, Radio context,
  satellite mission replay, and real per-class aircraft models with adjacent
  provenance records.
- Added a shared screen-space overlay system with bounded allocation for labels,
  cards, callouts, detection brackets, and selected-object presentation.

### Changed

- Unified right-side product controls and responsive cockpit/map layouts.
- Migrated public-safe neighborhood geometry to DataSF and tightened safe local
  development defaults.
- Improved proxy resilience, annotation outline bounds, CCTV enable pacing,
  contact de-emphasis, and deterministic visual stacking.

## [Unreleased] — July 2026

### Added

- Added live NASA FIRMS fires, optional live TomTom traffic, Caltrans and TfL
  CCTV packs, CCTV viewsheds and direct-manipulation calibration, citywide CCTV
  cards, Natural Earth regions, analyst queries, and voice routing QA.
- Added the end-to-end vertical-datum system for aircraft, vessels, CCTV,
  annotations, trails, and terrain-aware rendering.
- Added aircraft class silhouettes, path-derived display heading, ADSBDB
  enrichment, cached CelesTrak TLE lookup, and next-ISS-pass prediction.

### Fixed

- Fixed elevated-airport aircraft placement, vessel sea-surface placement,
  close-zoom FIRMS anchors, antimeridian region framing, annotation resolution,
  cross-layer tracking ownership, and CCTV projection lifecycle issues.

## [Unreleased] — June 2026

### Added

- Added OpenAI Realtime voice control, scene-aware entity context, viewport image
  grounding, the AI HUD summary, live AIS vessels, infrastructure layers, map
  source switching, free-text navigation, and server-side data proxies.
- Added hybrid map annotations, 3D aircraft, panoptic detection, tracking
  harnesses, and public data attribution.
- Added MIT source licensing, security guidance, contribution guidance, data
  source notices, and third-party asset boundaries.

### Changed

- Removed the experimental AI video-edit style and retained seven deterministic
  visual styles.
- Moved Realtime text-history trimming to the server-side retention policy while
  keeping only the latest viewport image in conversation context.

## [0.7.0] — 2026-02-18

- Added the Bikeshare Pulse layer and panoptic label improvements.
- Improved tracked-item boxes, post-render alignment, and CCTV projection
  quality.
- Removed the experimental shift-drag CCTV calibration interaction.

## [0.6.0] — 2026-02-10

- Added the initial multi-layer 3D globe experience, visual styles, live
  aircraft, satellites, earthquakes, CCTV, traffic, FIRMS, infrastructure, and
  performance controls.
- Added entity inspection, tracking, scenes, keyboard controls, and shareable
  views.

## [0.1.0] — 2026-02-09

- Initial project version.
