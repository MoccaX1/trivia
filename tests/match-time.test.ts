import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeMatchScheduler, SystemClock } from '../src/runtime/match-time.js';

test('Node scheduler rechecks authoritative time after early wakeup and supports cancellation', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  let fired = 0;
  const scheduler = new NodeMatchScheduler({ now: () => now });
  scheduler.schedule(10, () => {
    fired++;
  });
  now = 9;
  t.mock.timers.tick(10);
  assert.equal(fired, 0);
  now = 10;
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
  const cancel = scheduler.schedule(20, () => {
    fired++;
  });
  cancel();
  now = 20;
  t.mock.timers.tick(10);
  assert.equal(fired, 1);
});

test('Node scheduler forwards asynchronous clock errors through the callback instead of throwing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fail = false;
  let failure: unknown;
  const scheduler = new NodeMatchScheduler({
    now: () => {
      if (fail) throw new Error('Clock failed');
      return 0;
    },
  });
  scheduler.schedule(10, (error) => {
    failure = error;
  });
  fail = true;
  t.mock.timers.tick(10);
  assert.match(String(failure), /Clock failed/);
});

test('System clock supplies integer epoch milliseconds and never goes backwards', () => {
  const clock = new SystemClock();
  const first = clock.now();
  const second = clock.now();
  assert.ok(Number.isSafeInteger(first));
  assert.ok(second >= first);
});
