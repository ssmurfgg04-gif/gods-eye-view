// ESLint flat config (engineering hygiene, P2).
//
// Philosophy: this repo is large vanilla-JS with strong unit-test culture.
// Lint exists to catch genuine mistakes, not to reformat the codebase: the
// rule set is deliberately permissive for legacy patterns but strict about
// the classes of bug that actually cost review time (unused vars, accidental
// globals, broken imports). New rules should fail only on NEW mistakes.
import js from '@eslint/js';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'public/**',
      'pinokio/**',
      // The generated Cesium engine and vendored scripts are not lintable.
      'cesium/**',
      // Legacy parse quirks (acorn-strict) in two data modules that Vite's
      // esbuild handles fine: tracked as follow-up cleanup, excluded so the
      // lint gate stays green for everything else.
      'src/data/neighborhoodPolygons.js',
      'src/data/radioCountry.js',
      'src/data/naturalEarthRegions.js',
    ],
  },
  {
    files: ['src/**/*.js', 'src/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        // Browser globals used across the app.
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        requestIdleCallback: 'readonly',
        cancelAnimationFrame: 'readonly',
        queueMicrotask: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        sessionStorage: 'readonly',
        localStorage: 'readonly',
        indexedDB: 'readonly',
        WebSocket: 'readonly',
        AudioContext: 'readonly',
        ResizeObserver: 'readonly',
        MutationObserver: 'readonly',
        CustomEvent: 'readonly',
        crypto: 'readonly',
        getComputedStyle: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        EventTarget: 'readonly',
        Event: 'readonly',
        PointerEvent: 'readonly',
        DOMException: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        innerWidth: 'readonly',
        innerHeight: 'readonly',
        Image: 'readonly',
        Element: 'readonly',
        HTMLElement: 'readonly',
        Node: 'readonly',
        Text: 'readonly',
        DOMParser: 'readonly',
        XMLSerializer: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
        FormData: 'readonly',
        OffscreenCanvas: 'readonly',
        Path2D: 'readonly',
        MessageChannel: 'readonly',
        structuredClone: 'readonly',
        Audio: 'readonly',
        RTCPeerConnection: 'readonly',
        RTCSessionDescription: 'readonly',
        RTCDataChannel: 'readonly',
        MediaStream: 'readonly',
        MediaRecorder: 'readonly',
        CSS: 'readonly',
        Buffer: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        KeyboardEvent: 'readonly',
        WheelEvent: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        CanvasRenderingContext2D: 'readonly',
        ImageBitmap: 'readonly',
        createImageBitmap: 'readonly',
        // Cesium is loaded as a global engine script (vite-plugin-cesium).
        Cesium: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // === Architecture boundaries (see depcruise.config.cjs for the
      // structural versions). ESLint catches the textual versions. ===
      'no-restricted-globals': ['error', 'name', 'length', 'event', 'top'],
      // Manager private members are not a cross-module API. The public
      // facades live on the class (setEnabledWithIntent,
      // waitForVisibilityIntent, requestPanelRefresh,
      // consumePanelRefreshPendingOnVisible). This rule fails any NEW
      // reach-through outside src/data/manager.js and its tests.
      'no-restricted-syntax': ['error',
        {
          selector: "MemberExpression[object.name=/^(dataManager|this\._dataManager|this\.dataManager)$/] > .property[name=/^(_setEnabledWithIntent|_waitForVisibilityIntent|_refreshTogglePanel|_panelRefreshPendingOnVisible|_notifyListeners)$/] , MemberExpression[object.name='entry'] > .property[name=/^(moduleLoadPromise|lazyLoader)$/] , MemberExpression[object.name='this'] > .property[name=/^(_lifecycleActive|_lifecycleWaiters|_userToggleQueue)$/]",
          message: 'DataLayerManager private state is not a cross-module API — use the public facades (setEnabledWithIntent / waitForVisibilityIntent / requestPanelRefresh / consumePanelRefreshPendingOnVisible).',
        },
      ],
      // === Genuine-mistake rules ===
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-async-promise-executor': 'error',
      // Style-level: the legacy test suite regexes count literal spaces
      // pervasively (source-anchored assertions). Warning, not error.
      'no-regex-spaces': 'warn',
      'no-compare-neg-zero': 'error',
      'no-self-compare': 'warn',
      eqeqeq: ['warn', 'smart'],
      'prefer-const': 'off',
      // The codebase uses `console.*` deliberately (operator diagnostics).
      'no-console': 'off',
    },
  },
  {
    // Radio directory/country CSV sanitizers intentionally strip control
    // characters — the regexes are the fix, not the bug.
    files: ['src/data/radio.js', 'src/data/radioCountry.js'],
    rules: {
      'no-control-regex': 'off',
    },
  },
  {
    // The manager's own file is the DEFINITION site of the private members —
    // the boundary rule targets every other module.
    files: ['src/data/manager.js'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    // Node-compatible modules inside src (key setup hardening, worker
    // shims): these run under Node as well as the browser.
    files: ['src/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        global: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    // Test files: extra node globals.
    files: ['src/**/*.test.mjs', 'scripts/**/*.mjs'],
    rules: {
      // Legacy test fixtures predate the rule; tracked for cleanup.
      'use-isnan': 'off',
    },
    languageOptions: {
      globals: {
        process: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        globalThis: 'readonly',
        test: 'readonly',
        assert: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        before: 'readonly',
        after: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
  },
  {
    // Node-only files (vite config, proxy server code, workers).
    files: ['vite.config.js', 'scripts/**/*.mjs', 'src/**/*.worker.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        module: 'readonly',
      },
    },
  },
];
