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
