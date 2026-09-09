#!/usr/bin/env node
/**
 * Bundle-size budget gate (perf P2).
 *
 * Enforces the eager-JS budget on the built dist/ output:
 *
 * 1. An absolute ceiling per named budget (initial JS, initial CSS, total
 *    eager weight including modulepreloads) — catches catastrophic growth.
 * 2. A delta budget vs the committed baseline (config/bundle-budget.json):
 *    a PR may not grow the INITIAL chunk by more than GROWTH_ALLOWANCE_KB
 *    (gzip) without explicitly re-baselining. This is the "50 kB rule" from
 *    the performance roadmap: growth is a deliberate act, not an accident.
 *
 * Usage: node scripts/check-bundle-budget.mjs [--rebaseline]
 * Run AFTER `vite build`. Exits non-zero on violation.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'dist', 'assets');
const BASELINE_PATH = path.join(ROOT, 'config', 'bundle-budget.json');

/** Growth allowance vs baseline for the initial chunk, gzip KB. */
const GROWTH_ALLOWANCE_KB = 50;
/** Absolute ceilings (gzip KB). Baseline × generous-but-finite headroom. */
const CEILINGS = {
  initialJs: 260,
  eagerTotal: 320,
  initialCss: 60,
};

const rebaseline = process.argv.includes('--rebaseline');

function gzipKb(buffer) {
  return gzipSync(buffer).length / 1024;
}

function loadIndexHtml() {
  const index = path.join(ROOT, 'dist', 'index.html');
  if (!existsSync(index)) throw new Error('dist/index.html missing — run `vite build` first');
  return readFileSync(index, 'utf8');
}

function eagerChunksFromIndex(html) {
  const entry = (html.match(/src="(\/?assets\/index-[^"]+\.js)"/) || [])[1];
  const preloads = [...html.matchAll(/<link\b[^>]*rel="modulepreload"[^>]*>/g)]
    .map((m) => (m[0].match(/href="([^"]+)"/) || [])[1])
    .filter(Boolean);
  const all = new Set([entry, ...preloads].filter(Boolean));
  return [...all].map((p) => path.join(ROOT, 'dist', p.replace(/^\//, '')));
}

function main() {
  if (!existsSync(ASSETS)) {
    console.error('[budget] dist/assets missing — run `vite build` first');
    process.exit(2);
  }
  const html = loadIndexHtml();
  const eagerFiles = eagerChunksFromIndex(html);
  if (!eagerFiles.length) {
    console.error('[budget] could not resolve the entry chunk from dist/index.html');
    process.exit(2);
  }
  const cssFiles = readdirSync(ASSETS).filter((f) => f.endsWith('.css'))
    .map((f) => path.join(ASSETS, f));

  let initialJs = 0;
  for (const file of eagerFiles) {
    const kb = gzipKb(readFileSync(file));
    initialJs += kb;
    console.log(`[budget] eager JS  ${path.basename(file).padEnd(34)} ${kb.toFixed(1).padStart(8)} KB gzip`);
  }
  let initialCss = 0;
  for (const file of cssFiles) {
    const kb = gzipKb(readFileSync(file));
    initialCss += kb;
    console.log(`[budget] eager CSS ${path.basename(file).padEnd(34)} ${kb.toFixed(1).padStart(8)} KB gzip`);
  }
  const eagerTotal = initialJs + initialCss;
  console.log(`[budget] initial JS: ${initialJs.toFixed(1)} KB | eager total (JS+CSS): ${eagerTotal.toFixed(1)} KB (gzip)`);

  const measurements = { initialJs, initialCss, eagerTotal, updatedAt: new Date().toISOString() };

  if (rebaseline) {
    writeFileSync(BASELINE_PATH, JSON.stringify(measurements, null, 2) + '\n');
    console.log(`[budget] baseline REWRITTEN: ${BASELINE_PATH}`);
    process.exit(0);
  }

  const failures = [];
  if (initialJs > CEILINGS.initialJs) failures.push(`initial JS ${initialJs.toFixed(1)} KB exceeds ceiling ${CEILINGS.initialJs} KB`);
  if (eagerTotal > CEILINGS.eagerTotal) failures.push(`eager total ${eagerTotal.toFixed(1)} KB exceeds ceiling ${CEILINGS.eagerTotal} KB`);
  if (initialCss > CEILINGS.initialCss) failures.push(`initial CSS ${initialCss.toFixed(1)} KB exceeds ceiling ${CEILINGS.initialCss} KB`);

  if (existsSync(BASELINE_PATH)) {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    const growth = initialJs - Number(baseline.initialJs);
    if (growth > GROWTH_ALLOWANCE_KB) {
      failures.push(
        `initial JS grew ${growth.toFixed(1)} KB gzip over the committed baseline (${Number(baseline.initialJs).toFixed(1)} KB) — `
        + `more than the ${GROWTH_ALLOWANCE_KB} KB allowance. If this growth is intentional, re-baseline with `
        + `\`node scripts/check-bundle-budget.mjs --rebaseline\` and explain the delta in the PR description.`,
      );
    } else if (growth < -GROWTH_ALLOWANCE_KB) {
      console.log('[budget] significant SHRINKAGE — consider re-baselining to lock in the win.');
    }
  } else {
    console.log('[budget] no committed baseline found — writing one now');
    writeFileSync(BASELINE_PATH, JSON.stringify(measurements, null, 2) + '\n');
  }

  if (failures.length) {
    console.error('\n[budget] FAILED:');
    for (const failure of failures) console.error(`  ✖ ${failure}`);
    process.exit(1);
  }
  console.log('[budget] PASS — eager bundle within budget');
}

main();
