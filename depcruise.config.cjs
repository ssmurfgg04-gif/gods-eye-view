/**
 * dependency-cruiser rules (engineering hygiene, P2).
 *
 * Enforces the module boundaries the architecture already implies. The point
 * is not style — it is stopping the slow drift where a private state field
 * or a heavyweight module becomes someone else's import, which is exactly
 * how the eager-bundle leaks (hud.js → voice/gevActions.js → every layer)
 * happened silently for months.
 *
 * Run: npx depcruise src --config depcruise.config.cjs
 */
module.exports = {
  forbidden: [
    {
      name: 'no-core-to-voice',
      comment: 'Boot-critical modules (hud, ui boot paths) must not statically import the voice stack — it dragged every layer module into the eager graph. Use dynamic import() (see hud.js _summaryContext).',
      severity: 'error',
      from: { path: '^src/(hud|main)\.js$' },
      to: { path: '^src/voice/', dependencyTypesNot: ['dynamic-import'] },
    },
    {
      name: 'no-layer-from-manager',
      comment: 'The manager must stay layer-agnostic: layer implementations register themselves; the manager never imports them.',
      severity: 'error',
      from: { path: '^src/data/manager\.js$' },
      to: { path: '^src/data/(flights|militaryFlights|earthquakes|satellites|rocketLaunches|traffic|cctv|radio|bikeshare|aisLiveVessels|militaryInstallations|militaryAwareness|localLayers)\.js$' },
    },
    {
      name: 'no-worker-into-app',
      comment: 'Worker modules are separate build targets — they may import shared pure helpers, but app modules must never import a worker file.',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '\\.worker\\.mjs$' },
    },
    {
      name: 'no-cycles',
      comment: 'Circular imports are a slow-motion architecture failure. Keep dependencies acyclic; invert the dependency through an event/facade instead.',
      severity: 'warn',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'info',
      comment: 'Detect potentially dead modules (info-only: QA scripts and test fixtures are expected to look orphaned).',
      from: { orphan: true, pathNot: '^src/.*\\.test\\.mjs$' },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: { extensions: ['.js', '.mjs'] },
    reporterOptions: { dot: { theme: { graph: { rankdir: 'TB' } } } },
  },
};
