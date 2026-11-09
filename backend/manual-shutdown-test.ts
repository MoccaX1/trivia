import assert from 'node:assert/strict';
import { MatchCoordinator } from './src/application/match-coordinator.js';
import type { Clock, MatchScheduler } from './src/application/match-time.js';

class FakeClock implements Clock {
  now() {
    return 0;
  }
}

class FakeScheduler implements MatchScheduler {
  schedule(_deadline: number, _callback: (error?: unknown) => void) {
    return () => {};
  }
}

const coordinator = new MatchCoordinator(
  new FakeClock(),
  new FakeScheduler(),
  () => 'shutdown-match',
);

const created = await coordinator.create('host', 'create');
assert.equal(created.outcome.status, 'accepted');

const matchId = created.outcome.match.id;

console.log('--- PENDING COMMAND + SHUTDOWN ---');

// Intentionally do not await this command yet.
const pendingJoin = coordinator.dispatch('player-A', 'join', {
  type: 'join',
  matchId,
});

// Shutdown before the queued Join executes.
const shutdown1 = coordinator.shutdown();
const shutdown2 = coordinator.shutdown();

console.log('Same shutdown Promise:', shutdown1 === shutdown2);

const [join] = await Promise.all([
  pendingJoin,
  shutdown1,
]);

console.log('Pending Join status:', join.outcome.status);
console.log('Pending Join sequence:', join.receiptSequence);

assert.equal(join.outcome.status, 'accepted');
assert.equal(join.receiptSequence, 2);
assert.equal(shutdown1, shutdown2);

// Registry should be cleared after shutdown.
const lookup = coordinator.lookup(matchId);
console.log('Lookup after shutdown:', lookup.status);
assert.equal(lookup.status, 'missing');

// New commands must be blocked.
assert.throws(
  () => coordinator.create('host', 'after-shutdown'),
  /Match runtime is closed/,
);

assert.throws(
  () => coordinator.dispatch('player-B', 'join-after-shutdown', {
    type: 'join',
    matchId,
  }),
  /Match runtime is closed/,
);

console.log('New ingress blocked: true');
console.log('\nSTEP 7A: ALL ASSERTIONS PASSED');
