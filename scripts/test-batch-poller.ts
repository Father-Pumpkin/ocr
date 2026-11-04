#!/usr/bin/env node
/**
 * Batch poller regression test.
 *
 *   npx tsx scripts/test-batch-poller.ts    (or: npm run test:poller)
 *
 * The failure that matters here is a poller that never goes quiet: every check
 * is a database query, and a query every five minutes keeps Neon awake and
 * billing around the clock. The other way to get it wrong is going quiet too
 * early and stranding a batch, so both directions are covered.
 */
import assert from 'node:assert/strict';
import { createBatchPoller } from '../src/http/batch-poller.js';

const INTERVAL = 20;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A check that reports the queued in-flight counts, then nothing. */
function fakeCheck(inFlight: number[] = []) {
  const calls = { count: 0 };
  const check = async () => {
    calls.count++;
    return inFlight.shift() ?? 0;
  };
  return { check, calls };
}

// Nothing in flight: one check, then silence.
{
  const { check, calls } = fakeCheck();
  createBatchPoller(check, INTERVAL).wake();
  await wait(INTERVAL * 5);
  assert.equal(calls.count, 1, 'idle poller should check once and stop');
}

// Polls while a batch is in flight, and stops when it's done.
{
  const { check, calls } = fakeCheck([1, 1]);
  createBatchPoller(check, INTERVAL).wake();
  await wait(INTERVAL * 8);
  assert.equal(calls.count, 3, 'should poll until nothing is in flight, then stop');
}

// A failed check says nothing about what's in flight, so it keeps polling.
{
  let calls = 0;
  const check = async () => {
    calls++;
    if (calls === 1) throw new Error('database unavailable');
    return 0;
  };
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  createBatchPoller(check, INTERVAL).wake();
  await wait(INTERVAL * 5);
  process.stderr.write = write;
  assert.equal(calls, 2, 'a failed check should be retried');
}

// A batch submitted during a check that finds nothing isn't lost.
{
  let release = () => {};
  let calls = 0;
  const check = () => {
    calls++;
    if (calls > 1) return Promise.resolve(0);
    return new Promise<number>((resolve) => {
      release = () => resolve(0);
    });
  };
  const poller = createBatchPoller(check, INTERVAL);
  poller.wake();
  poller.wake(); // submitted while the first check is running
  release();
  await wait(INTERVAL * 5);
  assert.equal(calls, 2, 'a batch submitted mid-check needs a second check');
}

// A wake doesn't start a second loop alongside one that's already running.
{
  const { check, calls } = fakeCheck([1, 1]);
  const poller = createBatchPoller(check, INTERVAL);
  poller.wake();
  await wait(INTERVAL / 2);
  poller.wake();
  poller.wake();
  await wait(INTERVAL * 8);
  assert.equal(calls.count, 3, 'repeat wakes should not double the polling');
}

// Traffic can restart an idle poller, but no more often than the interval.
{
  const { check, calls } = fakeCheck();
  const poller = createBatchPoller(check, INTERVAL);
  poller.nudge();
  await wait(1);
  for (let i = 0; i < 20; i++) poller.nudge();
  await wait(1);
  assert.equal(calls.count, 1, 'a burst of requests should cost one check');
  await wait(INTERVAL * 2);
  poller.nudge();
  await wait(1);
  assert.equal(calls.count, 2, 'a later request should check again');
}

// A nudge finds batches this process didn't submit, and follows them through.
{
  const { check, calls } = fakeCheck([1]);
  createBatchPoller(check, INTERVAL).nudge();
  await wait(INTERVAL * 5);
  assert.equal(calls.count, 2, 'a batch found by a nudge should keep being polled');
}

process.stderr.write('Batch poller: all checks passed.\n');
