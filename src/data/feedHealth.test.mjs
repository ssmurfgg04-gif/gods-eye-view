import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeedHealth, feedHealth, _resetFeedHealthForTest } from './feedHealth.js';

/** Deterministic clock factory: starts at `start`, advances via `tick()`. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; return t; }, set: (ms) => { t = ms; return t; } };
}

test('a fresh feed is closed and attempts are allowed', () => {
  const health = createFeedHealth();
  const gate = health.shouldAttempt('usgs');
  assert.equal(gate.attempt, true);
  assert.equal(gate.state, 'closed');
  assert.equal(gate.probe, false);
});

test('failures below the threshold do not trip the breaker', () => {
  const health = createFeedHealth({ failureThreshold: 5 });
  for (let i = 0; i < 4; i += 1) health.recordResult('usgs', { ok: false });
  const gate = health.shouldAttempt('usgs');
  assert.equal(gate.attempt, true, 'still closed below the threshold');
});

test('consecutive failures at the threshold open the circuit', () => {
  const clock = fakeClock();
  const health = createFeedHealth({ now: clock.now, failureThreshold: 3, cooldownMs: 10_000 });
  for (let i = 0; i < 3; i += 1) {
    if (i > 0) clock.tick(1000); // between failures, not after the trip
    health.recordResult('usgs', { ok: false, durationMs: 50 });
  }
  const gate = health.shouldAttempt('usgs');
  assert.equal(gate.attempt, false);
  assert.equal(gate.state, 'open');
  assert.equal(gate.retryInMs, 10_000);
});

test('interleaved successes reset the consecutive-failure counter', () => {
  const health = createFeedHealth({ failureThreshold: 3 });
  health.recordResult('f', { ok: false });
  health.recordResult('f', { ok: false });
  health.recordResult('f', { ok: true });
  health.recordResult('f', { ok: false });
  health.recordResult('f', { ok: false });
  assert.equal(health.shouldAttempt('f').state, 'closed', 'no run of 3 → still closed');
});

test('sustained EWMA failure rate trips the breaker even without a hard run', () => {
  const health = createFeedHealth({
    failureThreshold: 100, // hard trip effectively disabled
    minSamples: 8,
    failureRateThreshold: 0.75,
    successAlpha: 0.5,
  });
  // Long alternating stretch (consecutive count stays ~1), then a short
  // failure TAIL: the EWMA crosses 0.75 with 24 samples — but the 4-failure
  // run is far below the hard threshold of 100. Only the EWMA path trips.
  for (let i = 0; i < 20; i += 1) {
    health.recordResult('flaky', { ok: i % 2 === 0 });
  }
  for (let i = 0; i < 4; i += 1) {
    health.recordResult('flaky', { ok: false });
  }
  const report = health.getFeedHealthSnapshot().feeds[0];
  assert.ok(report.samples >= 8);
  assert.ok(1 - report.successRate >= 0.75, `failure EWMA tripped (rate ${(1 - report.successRate).toFixed(3)})`);
  assert.equal(health.shouldAttempt('flaky').state, 'open', 'EWMA trip engages');
  assert.ok(report.consecutiveFailures < 100, 'the hard threshold never fired');
});

test('open circuit half-opens exactly when the cool-down elapses', () => {
  const clock = fakeClock();
  const health = createFeedHealth({ now: clock.now, failureThreshold: 2, cooldownMs: 5_000 });
  health.recordResult('f', { ok: false });
  health.recordResult('f', { ok: false });
  assert.equal(health.shouldAttempt('f').state, 'open');
  clock.tick(4_999);
  assert.equal(health.shouldAttempt('f').state, 'open', 'still open a moment early');
  clock.tick(1);
  const gate = health.shouldAttempt('f');
  assert.equal(gate.state, 'half-open');
  assert.equal(gate.attempt, true, 'the probe is allowed');
  assert.equal(gate.probe, true);
});

test('a successful probe closes the circuit and clears failures', () => {
  const clock = fakeClock();
  const health = createFeedHealth({ now: clock.now, failureThreshold: 2, cooldownMs: 5_000 });
  health.recordResult('f', { ok: false });
  health.recordResult('f', { ok: false });
  clock.tick(5_000);
  health.shouldAttempt('f'); // transitions to half-open
  const transition = health.recordResult('f', { ok: true, durationMs: 120 });
  assert.equal(transition.from, 'half-open');
  assert.equal(transition.to, 'closed');
  assert.equal(transition.recovered, true);
  assert.equal(health.shouldAttempt('f').state, 'closed');
  // And it takes a fresh failure RUN to trip again:
  health.recordResult('f', { ok: false });
  assert.equal(health.shouldAttempt('f').state, 'closed', 'one failure is not a trip after recovery');
});

test('a failed probe re-opens with an ESCALATED cool-down', () => {
  const clock = fakeClock();
  const health = createFeedHealth({
    now: clock.now, failureThreshold: 2, cooldownMs: 10_000, maxCooldownMs: 100_000,
  });
  health.recordResult('f', { ok: false });
  health.recordResult('f', { ok: false }); // trip 1 → 10 s cool-down
  clock.tick(10_000);
  health.shouldAttempt('f'); // half-open
  const retrip = health.recordResult('f', { ok: false });
  assert.equal(retrip.to, 'open');
  const gate = health.shouldAttempt('f');
  assert.equal(gate.attempt, false);
  assert.equal(gate.retryInMs, 20_000, 'second outage doubles the cool-down');
});

test('escalated cool-downs are capped at maxCooldownMs', () => {
  const clock = fakeClock();
  const health = createFeedHealth({
    now: clock.now, failureThreshold: 1, cooldownMs: 10_000, maxCooldownMs: 30_000,
  });
  for (let round = 0; round < 6; round += 1) {
    health.recordResult('f', { ok: false }); // trips (or re-trips)
    const { retryInMs } = health.shouldAttempt('f');
    assert.ok(retryInMs <= 30_000, `round ${round}: cool-down ${retryInMs} respects the cap`);
    clock.tick(retryInMs); // elapse the cool-down → half-open
    health.shouldAttempt('f');
  }
});

test('EWMA success rate and latency track recent results', () => {
  const health = createFeedHealth({ successAlpha: 0.5, latencyAlpha: 0.5 });
  health.recordResult('f', { ok: true, durationMs: 100 });
  health.recordResult('f', { ok: true, durationMs: 200 });
  health.recordResult('f', { ok: false });
  const report = health.getFeedHealthSnapshot().feeds[0];
  // EWMA(success) with α=0.5: 1 → 1 → 0.5
  assert.equal(report.successRate, 0.5);
  // EWMA(latency) with α=0.5: 100 → 150 (failures do not update latency)
  assert.equal(report.latencyMs, 150);
  assert.equal(report.samples, 3);
});

test('stale successes keep the breaker happy but land in staleShare', () => {
  const health = createFeedHealth({ staleAlpha: 0.5, failureThreshold: 2 });
  health.recordResult('f', { ok: true, stale: true, durationMs: 10 });
  health.recordResult('f', { ok: true, stale: true, durationMs: 10 });
  const report = health.getFeedHealthSnapshot().feeds[0];
  assert.equal(report.state, 'closed', 'serve-stale is a SUCCESS for the breaker');
  assert.equal(report.staleShare, 1, 'but the stale share tells the truth');
  health.recordResult('f', { ok: true, durationMs: 10 });
  const after = health.getFeedHealthSnapshot().feeds[0];
  assert.ok(after.staleShare < 1, 'fresh success pulls the stale share down');
});

test('noteCircuitSkip counts skips without registering failures', () => {
  const health = createFeedHealth({ failureThreshold: 3 });
  health.noteCircuitSkip('f');
  health.noteCircuitSkip('f');
  const report = health.getFeedHealthSnapshot().feeds[0];
  assert.equal(report.skipCount, 2);
  assert.equal(report.samples, 0, 'a skip is not a sample');
  assert.equal(report.state, 'closed');
});

test('the snapshot is frozen and one report per feed', () => {
  const health = createFeedHealth();
  health.recordResult('a', { ok: true });
  health.recordResult('b', { ok: true });
  const snapshot = health.getFeedHealthSnapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.equal(snapshot.feeds.length, 2);
  assert.ok(Object.isFrozen(snapshot.feeds[0]));
  assert.deepEqual(snapshot.feeds.map((f) => f.feedId).sort(), ['a', 'b']);
});

test('retryInMs shrinks as the cool-down elapses and reports 0 otherwise', () => {
  const clock = fakeClock();
  const health = createFeedHealth({ now: clock.now, failureThreshold: 1, cooldownMs: 10_000 });
  health.recordResult('f', { ok: false });
  const first = health.getFeedHealthSnapshot().feeds[0].retryInMs;
  clock.tick(4_000);
  const later = health.getFeedHealthSnapshot().feeds[0].retryInMs;
  assert.equal(first, 10_000);
  assert.equal(later, 6_000);
  health.recordResult('healthy', { ok: true });
  assert.equal(health.getFeedHealthSnapshot().feeds.find((f) => f.feedId === 'healthy').retryInMs, 0);
});

test('reset forgets every feed', () => {
  const health = createFeedHealth({ failureThreshold: 1 });
  health.recordResult('f', { ok: false });
  health.reset();
  assert.equal(health.getFeedHealthSnapshot().feeds.length, 0);
  assert.equal(health.shouldAttempt('f').state, 'closed');
});

test('feed ids are string-coerced so numeric ids cannot fork circuits', () => {
  const health = createFeedHealth({ failureThreshold: 1 });
  health.recordResult(7, { ok: false });
  const report = health.getFeedHealthSnapshot().feeds[0];
  assert.equal(report.feedId, '7');
  assert.equal(health.shouldAttempt(7).state, 'open');
  assert.equal(health.shouldAttempt('7').state, 'open', 'same circuit for both spellings');
});

test('the module singleton exists and resets cleanly for tests', () => {
  assert.ok(feedHealth);
  _resetFeedHealthForTest();
  assert.equal(feedHealth.getFeedHealthSnapshot().feeds.length, 0);
  assert.equal(typeof feedHealth.shouldAttempt, 'function');
});
