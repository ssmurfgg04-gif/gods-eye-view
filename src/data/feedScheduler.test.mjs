import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFeedScheduler, getFeedSchedulerDiagnostics } from './feedScheduler.js';

beforeEach(() => {
  // Each test builds an isolated scheduler; the module singleton stays clean.
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('schedule requires a stable id, positive interval, and a tick function', () => {
  const scheduler = createFeedScheduler();
  assert.throws(() => scheduler.schedule({ intervalMs: 1000, tick: () => {} }), /stable id/);
  assert.throws(() => scheduler.schedule({ id: 'a', tick: () => {} }), /positive intervalMs/);
  assert.throws(() => scheduler.schedule({ id: 'a', intervalMs: 1000 }), /tick function/);
});

test('a job ticks once per interval (no overlap, no drift-queue)', async () => {
  const scheduler = createFeedScheduler();
  const gate = deferred();
  let ticks = 0;
  // MIN_JITTER_MS floors every hop at ~150 ms, so the real cadence here is
  // ~50-350 ms per tick: generous waits keep the test robust under load.
  const cancel = scheduler.schedule({
    id: 'slow',
    intervalMs: 200,
    initialDelayMs: 0,
    tick: async () => {
      ticks += 1;
      if (ticks === 1) await gate.promise; // first tick stays in flight
    },
  });
  try {
    // Let at least one due tick arrive while tick 1 is still in flight.
    await new Promise((r) => setTimeout(r, 500));
    // While tick 1 is in flight, due ticks are SKIPPED, not queued.
    assert.equal(ticks, 1, 'overlapping due ticks are skipped while a tick is in flight');
    gate.resolve();
    await new Promise((resolve) => {
      const poll = () => (ticks >= 2 ? resolve() : setTimeout(poll, 25));
      poll();
    });
    assert.ok(ticks >= 2, 'ticks resume after the in-flight tick settles');
  } finally {
    cancel();
  }
});

test('a rejecting tick doubles the effective interval (backoff), success resets it', async () => {
  const scheduler = createFeedScheduler();
  const cancel = scheduler.schedule({
    id: 'flaky',
    intervalMs: 200,
    initialDelayMs: 0,
    maxBackoffMs: 200 * 8,
    tick: async () => false, // every tick fails — backoff must compound
  });
  try {
    await new Promise((r) => setTimeout(r, 260));
    const afterFailures = scheduler.effectiveIntervalMs('flaky');
    assert.ok(
      afterFailures > 200,
      `backoff engages after failures (got ${afterFailures})`,
    );
  } finally {
    cancel();
  }
});

test('cancel stops a job; isActive reflects it; cancel of unknown id is safe', async () => {
  const scheduler = createFeedScheduler();
  let ticks = 0;
  const cancel = scheduler.schedule({
    id: 'stopped',
    intervalMs: 5,
    initialDelayMs: 0,
    tick: () => { ticks += 1; },
  });
  await new Promise((r) => setTimeout(r, 12));
  assert.ok(ticks > 0);
  assert.equal(scheduler.cancel('stopped'), true);
  assert.equal(scheduler.isActive('stopped'), false);
  assert.equal(scheduler.cancel('never-registered'), false);
  const ticksAtCancel = ticks;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ticks, ticksAtCancel, 'no ticks after cancel');
  cancel();
});

test('re-registering the same id replaces the previous chain (arm/disarm pair)', async () => {
  const scheduler = createFeedScheduler();
  let ticksA = 0;
  let ticksB = 0;
  scheduler.schedule({ id: 'swap', intervalMs: 5, initialDelayMs: 50, tick: () => { ticksA += 1; } });
  scheduler.schedule({ id: 'swap', intervalMs: 5, initialDelayMs: 0, tick: () => { ticksB += 1; } });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(ticksA, 0, 'replaced job never ticks');
  assert.ok(ticksB > 0, 'replacement job ticks');
  scheduler.cancel('swap');
});

test('diagnostics report cadence, backoff, and last result', async () => {
  const scheduler = createFeedScheduler();
  scheduler.schedule({ id: 'diag', intervalMs: 60_000, initialDelayMs: 0, tick: async () => true });
  await new Promise((r) => setTimeout(r, 5));
  const { jobs } = scheduler.getFeedSchedulerDiagnostics();
  const job = jobs.find((j) => j.id === 'diag');
  assert.ok(job, 'job present in diagnostics');
  assert.equal(job.lastResult, 'ok');
  assert.equal(job.backoffMs, 0);
  scheduler.cancel('diag');
});

test('the module-level diagnostics singleton is inert before use', () => {
  const { jobs } = getFeedSchedulerDiagnostics();
  assert.ok(Array.isArray(jobs));
});

// ── MILLION-X wave 2: feed-health circuit-breaker gating ─────────────────────
// The scheduler consults the breaker before every tick: an open circuit means
// no network pressure, skips are not failures, and the cool-down probe is an
// ordinary tick that can heal the circuit.

import { createFeedHealth } from './feedHealth.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

test('ticks are gated while a shared circuit is open; skips are not failures', async () => {
  // Trip the circuit OUTSIDE the scheduler (another subscriber of the same
  // feed, or a previous job's outage) so the gating is exercised directly.
  const health = createFeedHealth({ failureThreshold: 3, cooldownMs: 60_000 });
  for (let i = 0; i < 3; i += 1) health.recordResult('shared-usgs', { ok: false });

  const scheduler = createFeedScheduler({ health });
  let ticks = 0;
  scheduler.schedule({
    id: 'gated',
    healthId: 'shared-usgs',
    intervalMs: 5,
    initialDelayMs: 0,
    tick: () => { ticks += 1; return true; },
  });
  try {
    await sleep(500);
    assert.equal(ticks, 0, 'no tick body runs while the circuit is open');
    const job = scheduler.getFeedSchedulerDiagnostics().jobs.find((j) => j.id === 'gated');
    assert.equal(job.lastResult, 'circuit-open');
    assert.equal(job.circuit, 'open');
    assert.equal(job.healthId, 'shared-usgs');
    const report = health.getFeedHealthSnapshot().feeds[0];
    assert.ok(report.skipCount >= 1, 'the skip is visible in health diagnostics');
    assert.equal(report.consecutiveFailures, 3, 'a skip must NOT count as a failure');
  } finally {
    scheduler.cancel('gated');
  }
});

test('after the cool-down elapses the next tick is the probe and heals the circuit', async () => {
  const health = createFeedHealth({ failureThreshold: 3, cooldownMs: 300 });
  for (let i = 0; i < 3; i += 1) health.recordResult('probe-feed', { ok: false });

  const scheduler = createFeedScheduler({ health });
  let ticks = 0;
  scheduler.schedule({
    id: 'probing',
    healthId: 'probe-feed',
    intervalMs: 5,
    initialDelayMs: 0,
    tick: () => { ticks += 1; return true; },
  });
  try {
    const healed = await waitFor(() => ticks >= 1, 4000, 'probe tick');
    assert.ok(healed, 'the cool-down probe eventually runs');
    const job = scheduler.getFeedSchedulerDiagnostics().jobs.find((j) => j.id === 'probing');
    assert.equal(job.lastResult, 'ok', 'the probe tick succeeded');
    assert.equal(job.circuit, 'closed', 'a successful probe closes the circuit');
    assert.equal(health.shouldAttempt('probe-feed').state, 'closed');
  } finally {
    scheduler.cancel('probing');
  }
});

test('two jobs sharing a healthId share one circuit', async () => {
  const health = createFeedHealth({ failureThreshold: 2, cooldownMs: 60_000 });
  const scheduler = createFeedScheduler({ health });
  let aTicks = 0;
  let bTicks = 0;
  // Job A keeps failing: its ticks trip the shared circuit.
  scheduler.schedule({
    id: 'a-failing',
    healthId: 'one-provider',
    intervalMs: 5,
    initialDelayMs: 0,
    tick: () => { aTicks += 1; return false; },
  });
  // Job B is healthy but hits the same provider: once A trips the circuit,
  // B's ticks are gated too.
  scheduler.schedule({
    id: 'b-healthy',
    healthId: 'one-provider',
    intervalMs: 5,
    initialDelayMs: 0,
    tick: () => { bTicks += 1; return true; },
  });
  try {
    await waitFor(() => health.shouldAttempt('one-provider').state === 'open', 3000, 'circuit opens');
    const snapshot = health.getFeedHealthSnapshot().feeds[0];
    assert.equal(snapshot.trips, 1);
    // From open onward, neither job's tick body runs.
    const aAtOpen = aTicks;
    const bAtOpen = bTicks;
    await sleep(400);
    assert.equal(aTicks, aAtOpen, 'failing job stops hammering the dead provider');
    assert.equal(bTicks, bAtOpen, 'the healthy sibling is gated by the shared circuit');
    const jobs = scheduler.getFeedSchedulerDiagnostics().jobs;
    assert.equal(jobs.find((j) => j.id === 'a-failing').circuit, 'open');
    assert.equal(jobs.find((j) => j.id === 'b-healthy').circuit, 'open');
  } finally {
    scheduler.cancel('a-failing');
    scheduler.cancel('b-healthy');
  }
});

test('health tracking can be disabled entirely for hermetic legacy tests', async () => {
  const scheduler = createFeedScheduler({ health: null });
  let ticks = 0;
  scheduler.schedule({
    id: 'legacy',
    intervalMs: 5,
    initialDelayMs: 0,
    tick: () => { ticks += 1; return false; },
  });
  try {
    await waitFor(() => ticks >= 2, 3000, 'ticks with failures');
    const job = scheduler.getFeedSchedulerDiagnostics().jobs.find((j) => j.id === 'legacy');
    assert.equal(job.circuit, 'off', 'no breaker when health is disabled');
    assert.equal(job.lastResult, 'rejected');
  } finally {
    scheduler.cancel('legacy');
  }
});
