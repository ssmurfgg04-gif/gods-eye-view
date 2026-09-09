import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessProvenance,
  attachProvenance,
  createProvenanceRecord,
  formatAge,
  getProvenance,
  reviseProvenance,
  summarizeProvenance,
} from './provenance.js';

test('createProvenanceRecord mints a frozen revision-0 record with stable identity', () => {
  const record = createProvenanceRecord({
    source: 'USGS',
    feedId: 'earthquakes',
    subjectId: 'us7000abcd',
    fetchedAt: 1_000,
    observedAt: 900,
    confidence: 0.9,
  });
  assert.equal(record.revision, 0);
  assert.equal(record.parentId, null);
  assert.equal(record.id, 'earthquakes#us7000abcd#r0');
  assert.equal(record.corrections.length, 0);
  assert.ok(Object.isFrozen(record));
});

test('record construction is defensive: timestamps fall back, confidence clamps', () => {
  const record = createProvenanceRecord({ confidence: 7 });
  assert.ok(Number.isFinite(record.fetchedAt));
  assert.ok(Number.isFinite(record.observedAt));
  assert.equal(record.confidence, 1, 'confidence above 1 clamps to 1');
  const low = createProvenanceRecord({ confidence: -3 });
  assert.equal(low.confidence, 0, 'confidence below 0 clamps to 0');
  const garbage = createProvenanceRecord({});
  assert.equal(garbage.feedId, 'unknown');
  assert.equal(garbage.source, 'unknown');
});

test('reviseProvenance mints revision+1, links the parent, and accumulates corrections', () => {
  const base = createProvenanceRecord({
    feedId: 'earthquakes', subjectId: 'us1', fetchedAt: 1_000, observedAt: 900,
  });
  const revised = reviseProvenance(base, {
    at: 1_500,
    corrections: [{ field: 'mag', from: 4.2, to: 4.5 }],
  });
  assert.equal(revised.revision, 1);
  assert.equal(revised.parentId, base.id);
  assert.equal(revised.id, 'earthquakes#us1#r1');
  assert.equal(revised.fetchedAt, 1_500);
  assert.equal(revised.observedAt, 900, 'revisions re-fetch, they do not re-observe');
  assert.equal(revised.corrections.length, 1);
  assert.equal(revised.corrections[0].field, 'mag');
  assert.equal(revised.corrections[0].from, 4.2);
  assert.equal(revised.corrections[0].to, 4.5);
  assert.equal(revised.corrections[0].at, 1_500);
  // The parent is untouched — append-only history.
  assert.equal(base.revision, 0);
  assert.equal(base.corrections.length, 0);
});

test('a second revision chains off the first and keeps both corrections', () => {
  const base = createProvenanceRecord({ feedId: 'earthquakes', subjectId: 'us1' });
  const r1 = reviseProvenance(base, { at: 100, corrections: [{ field: 'mag', from: 4.2, to: 4.5 }] });
  const r2 = reviseProvenance(r1, { at: 200, corrections: [{ field: 'mag', from: 4.5, to: 4.8 }] });
  assert.equal(r2.revision, 2);
  assert.equal(r2.parentId, r1.id);
  assert.equal(r2.corrections.length, 2);
  assert.deepEqual(r2.corrections.map((c) => c.to), [4.5, 4.8]);
});

test('the corrections chain is capped (bounded memory)', () => {
  let record = createProvenanceRecord({ feedId: 'f' });
  for (let i = 0; i < 20; i += 1) {
    record = reviseProvenance(record, { at: i, corrections: [{ field: 'x', from: i, to: i + 1 }] });
  }
  assert.ok(record.corrections.length <= 16, `capped, got ${record.corrections.length}`);
  assert.equal(record.revision, 20, 'revision count is NOT capped — it is the true history length');
});

test('reviseProvenance on garbage input degrades to a fresh record, never throws', () => {
  const record = reviseProvenance(null, { corrections: [{ field: 'mag', from: 1, to: 2 }] });
  assert.equal(record.revision, 1);
  assert.equal(record.corrections.length, 1);
  const fromString = reviseProvenance('not a record', {});
  assert.equal(fromString.revision, 1);
});

test('assessProvenance: fresh, confident, unrevised → trusted', () => {
  const record = createProvenanceRecord({ fetchedAt: 1_000, observedAt: 900, confidence: 0.9 });
  const verdict = assessProvenance(record, { maxAgeMs: 500, minConfidence: 0.4 }, 1_100);
  assert.equal(verdict.verdict, 'trusted');
  assert.deepEqual(verdict.reasons, []);
});

test('assessProvenance: age beyond policy → stale (highest-priority verdict)', () => {
  const record = createProvenanceRecord({ fetchedAt: 1_000, observedAt: 100, confidence: 0.2 });
  const verdict = assessProvenance(record, { maxAgeMs: 500, minConfidence: 0.4 }, 1_100);
  assert.equal(verdict.verdict, 'stale');
  assert.equal(verdict.reasons.length, 2, 'both stale AND low-confidence are reported');
  assert.match(verdict.reasons[0], /observed/);
});

test('assessProvenance: low confidence alone → low-confidence', () => {
  const record = createProvenanceRecord({ observedAt: 1_000, confidence: 0.3 });
  const verdict = assessProvenance(record, { maxAgeMs: 10_000, minConfidence: 0.5 }, 1_050);
  assert.equal(verdict.verdict, 'low-confidence');
  assert.match(verdict.reasons[0], /confidence/);
});

test('assessProvenance: excessive revisions → volatile', () => {
  let record = createProvenanceRecord({ observedAt: 1_000, confidence: 0.9 });
  for (let i = 0; i < 5; i += 1) record = reviseProvenance(record, { at: 1_010 });
  const verdict = assessProvenance(record, { maxRevisions: 2 }, 1_100);
  assert.equal(verdict.verdict, 'volatile');
});

test('assessProvenance on a missing record grades low-confidence, never throws', () => {
  const verdict = assessProvenance(null, {});
  assert.equal(verdict.verdict, 'low-confidence');
});

test('attachProvenance/getProvenance round-trips through a WeakMap', () => {
  const entity = { id: 'quake-1' };
  const record = createProvenanceRecord({ feedId: 'earthquakes', subjectId: 'us1' });
  const returned = attachProvenance(entity, record);
  assert.equal(returned, entity, 'chainable');
  assert.equal(getProvenance(entity), record);
});

test('attachment never changes the target serialization or an unrelated object', () => {
  const entity = { id: 'quake-2', mag: 4.5 };
  const before = JSON.stringify(entity);
  attachProvenance(entity, createProvenanceRecord({}));
  assert.equal(JSON.stringify(entity), before, 'no shape change, no leak into JSON');
  assert.equal(getProvenance({ id: 'other' }), null);
  assert.equal(getProvenance(null), null);
  assert.equal(getProvenance('string'), null);
  attachProvenance(null, record0()); // safe no-op
  function record0() { return createProvenanceRecord({}); }
});

test('summarizeProvenance spells out source, ages, confidence, and revisions', () => {
  const base = createProvenanceRecord({
    source: 'USGS', feedId: 'earthquakes', subjectId: 'us1',
    fetchedAt: 1_000, observedAt: 400, confidence: 0.9,
  });
  const revised = reviseProvenance(base, {
    at: 1_200,
    corrections: [{ field: 'mag', from: 4.2, to: 4.5 }],
  });
  const summary = summarizeProvenance(revised, { now: 2_000 });
  assert.match(summary, /USGS/);
  assert.match(summary, /observed 1\.6s ago/);
  assert.match(summary, /fetched 800ms ago/);
  assert.match(summary, /confidence 0\.90/);
  assert.match(summary, /rev 1/);
  assert.match(summary, /mag 4\.2→4\.5/);
  assert.equal(summarizeProvenance(null), 'no provenance');
});

test('formatAge covers ms → s → m → h → d', () => {
  assert.equal(formatAge(50), '50ms');
  assert.equal(formatAge(950), '950ms');
  assert.equal(formatAge(1_000), '1.0s');
  assert.equal(formatAge(9_000), '9.0s');
  assert.equal(formatAge(30_000), '30s');
  assert.equal(formatAge(60_000), '1m');
  assert.equal(formatAge(75 * 60_000), '1h');
  assert.equal(formatAge(90 * 60_000), '2h', '1.5 h rounds up');
  assert.equal(formatAge(90 * 60_000 * 24), '2d');
  assert.equal(formatAge(-5), '0ms');
});
