import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HALF_LIFE_MS,
  createRelevanceScorer,
  normalizeSeverity,
  recencyDecay,
  selectWithinRelevanceBudget,
} from './relevance.js';

const NOW = 1_000_000;
const now = () => NOW;

test('recencyDecay: 1 at birth, 0.5 at one half-life, floor at extreme age', () => {
  assert.equal(recencyDecay(0, 1000), 1);
  assert.ok(Math.abs(recencyDecay(1000, 1000) - 0.5) < 1e-9);
  assert.ok(Math.abs(recencyDecay(2000, 1000) - 0.25) < 1e-9);
  assert.equal(recencyDecay(1e12, 1000), 0.001, 'decay floors rather than zeroing');
  assert.equal(recencyDecay(-50, 1000), 1, 'negative age clamps to 0');
  assert.equal(recencyDecay(500, 0), recencyDecay(500, DEFAULT_HALF_LIFE_MS), 'bogus half-life falls back to default');
});

test('normalizeSeverity: endpoints, monotonicity, and the power curve', () => {
  assert.equal(normalizeSeverity(0), 0.05, 'severity floor keeps small events selectable');
  assert.equal(normalizeSeverity(1), 1);
  assert.equal(normalizeSeverity(-1), 0.05, 'below range clamps');
  assert.equal(normalizeSeverity(5), 1, 'above range clamps');
  assert.ok(normalizeSeverity(0.6, { severityExponent: 1.5 }) < 0.6, 'power curve pulls mid-range down');
  assert.ok(normalizeSeverity(0.6) < normalizeSeverity(0.7), 'monotonic in severity');
  assert.equal(normalizeSeverity(NaN), 0);
  assert.equal(normalizeSeverity(5, { severityRange: [10, 10] }), 0, 'degenerate range scores 0');
});

test('scorer returns null for items with NO relevance signals (fallback contract)', () => {
  const scorer = createRelevanceScorer({ now });
  assert.equal(scorer({ id: 'a', priority: 5 }), null, 'neither observedAt nor severity');
  assert.equal(scorer({ id: 'a', observedAt: null, severity: null }), null);
  assert.equal(scorer(null), null);
  // THE trap this guards: Number(null) === 0 must NOT forge an epoch-zero event.
  assert.equal(scorer({ observedAt: null }), null, 'null observedAt is not epoch zero');
  assert.equal(scorer({ severity: null }), null, 'null severity is not severity 0');
});

test('severity-only scoring ranks by the severity curve', () => {
  const scorer = createRelevanceScorer({ now, severityRange: [2.5, 8] });
  const big = scorer({ severity: 7 });
  const small = scorer({ severity: 3 });
  assert.ok(big > small);
  assert.ok(small > 0);
});

test('observedAt-only scoring uses a 0.5 base weight', () => {
  const scorer = createRelevanceScorer({ now });
  const fresh = scorer({ observedAt: NOW });
  assert.ok(Math.abs(fresh - 0.5) < 1e-9);
  const aged = scorer({ observedAt: NOW - DEFAULT_HALF_LIFE_MS });
  assert.ok(Math.abs(aged - 0.25) < 1e-9);
});

test('severity × recency: a fresh M4.9 outranks a 12 h-old M6.5', () => {
  const scorer = createRelevanceScorer({ now, severityRange: [2.5, 8] });
  const halfLife = DEFAULT_HALF_LIFE_MS; // 6 h
  const freshModerate = scorer({ severity: 4.9, observedAt: NOW - 60_000 });
  const oldLarge = scorer({ severity: 6.5, observedAt: NOW - 2 * halfLife });
  assert.ok(freshModerate > oldLarge, `fresh M4.9 (${freshModerate.toFixed(4)}) must beat 12 h-old M6.5 (${oldLarge.toFixed(4)})`);
});

test('interaction boost doubles a fresh click and decays with age', () => {
  const scorer = createRelevanceScorer({ now, severityRange: [0, 1] });
  const plain = scorer({ severity: 0.5, observedAt: NOW });
  const touchedNow = scorer({ severity: 0.5, observedAt: NOW, interactedAt: NOW });
  assert.ok(Math.abs(touchedNow / plain - 2) < 1e-9, 'fresh interaction = 2×');
  const touchedYesterday = scorer({ severity: 0.5, observedAt: NOW, interactedAt: NOW - 4 * DEFAULT_HALF_LIFE_MS });
  assert.ok(touchedYesterday > plain && touchedYesterday < touchedNow, 'old interaction boosts less');
  assert.equal(scorer({ severity: 0.5, observedAt: NOW, interactedAt: null }), plain, 'null interaction is no boost');
});

test('selectWithinRelevanceBudget: zero/negative budget selects nothing', () => {
  const items = [{ id: 'a', severity: 1, observedAt: NOW }];
  assert.deepEqual(selectWithinRelevanceBudget(items, 0, { now }), []);
  assert.deepEqual(selectWithinRelevanceBudget(items, -5, { now }), []);
});

test('selectWithinRelevanceBudget returns null when NO item scores (legacy fallback)', () => {
  const items = [{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }];
  assert.equal(selectWithinRelevanceBudget(items, 2, { now }), null);
  assert.equal(selectWithinRelevanceBudget('not an array', 2, { now }), null);
});

test('all-scored selection: score desc, id asc tie-break, capped at budget', () => {
  const now = () => 10_000;
  const items = [
    { id: 'a', severity: 0.5, observedAt: 9_000 },
    { id: 'b', severity: 0.9, observedAt: 9_000 },
    { id: 'c', severity: 0.9, observedAt: 9_000 },
    { id: 'd', severity: 0.2, observedAt: 9_000 },
  ];
  const selection = selectWithinRelevanceBudget(items, 3, { now });
  assert.deepEqual(selection.map((i) => i.id), ['b', 'c', 'a']);
  const top2 = selectWithinRelevanceBudget(items, 2, { now });
  assert.deepEqual(top2.map((i) => i.id), ['b', 'c']);
});

test('ties break by id in LOCALE-STABLE ascending order', () => {
  const items = [
    { id: 'zz', severity: 1, observedAt: 1 },
    { id: 'aa', severity: 1, observedAt: 1 },
    { id: 'mm', severity: 1, observedAt: 1 },
  ];
  const selection = selectWithinRelevanceBudget(items, 3, { now: () => 2 });
  assert.deepEqual(selection.map((i) => i.id), ['aa', 'mm', 'zz']);
});

test('mixed cohort: scored items rank ahead of unscored, unscored keep input order', () => {
  const items = [
    { id: 'legacy-1', priority: 100 },
    { id: 'scored-low', severity: 0.1, observedAt: 9_000 },
    { id: 'legacy-2', priority: 50 },
    { id: 'scored-high', severity: 0.9, observedAt: 9_000 },
  ];
  const selection = selectWithinRelevanceBudget(items, 4, { now: () => 10_000 });
  assert.deepEqual(selection.map((i) => i.id), ['scored-high', 'scored-low', 'legacy-1', 'legacy-2']);
});

test('unscored items backfill only when the scored set underfills the budget', () => {
  const items = [
    { id: 'scored', severity: 1, observedAt: 9_000 },
    { id: 'legacy-1' },
    { id: 'legacy-2' },
  ];
  const selection = selectWithinRelevanceBudget(items, 2, { now: () => 10_000 });
  assert.deepEqual(selection.map((i) => i.id), ['scored', 'legacy-1']);
});

test('selection is by REFERENCE — the same objects come back, unmutated', () => {
  const item = { id: 'x', severity: 1, observedAt: 9_000 };
  const [selected] = selectWithinRelevanceBudget([item], 1, { now: () => 10_000 });
  assert.equal(selected, item);
  assert.equal(selected.relevanceScore, undefined, 'no score pollution on the item');
});

test('custom accessors drive scoring (observedAtOf/severityOf)', () => {
  const items = [
    { id: 'raw-mag', rawMag: 6, when: 9_500 },
    { id: 'raw-mag-2', rawMag: 3, when: 9_900 },
  ];
  const selection = selectWithinRelevanceBudget(items, 1, {
    now: () => 10_000,
    observedAtOf: (item) => (item.when != null ? item.when : null),
    severityOf: (item) => (item.rawMag != null ? item.rawMag : null),
    severityRange: [2.5, 8],
  });
  assert.equal(selection[0].id, 'raw-mag');
});

test('the scorer clamps a bogus interactionBoost to >= 1', () => {
  const scorer = createRelevanceScorer({ now, interactionBoost: -5 });
  const plain = scorer({ severity: 1, observedAt: NOW });
  const boosted = scorer({ severity: 1, observedAt: NOW, interactedAt: NOW });
  assert.ok(boosted >= plain, 'negative boost cannot suppress items');
});
