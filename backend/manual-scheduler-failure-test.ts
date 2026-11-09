import assert from 'node:assert/strict';
import { MatchCoordinator } from './src/application/match-coordinator.js';
import type { Clock, MatchScheduler } from './src/application/match-time.js';
import type { PrivateQuestion } from './src/domain/match-engine.js';

class FakeClock implements Clock {
  time = 0;

  now(): number {
    return this.time;
  }
}

class FailingScheduler implements MatchScheduler {
  scheduleCalls = 0;

  schedule(
    _deadlineAt: number,
    _callback: (error?: unknown) => void,
  ): () => void {
    this.scheduleCalls++;
    throw new Error('MANUAL_SCHEDULER_FAILURE');
  }
}

const questions: readonly PrivateQuestion[] = Array.from(
  { length: 10 },
  (_, i) => ({
    id: `q${i}`,
    text: `Question ${i}`,
    choices: [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
    ],
    correctChoiceId: 'b',
  }),
);

const clock = new FakeClock();
const scheduler = new FailingScheduler();

const coordinator = new MatchCoordinator(
  clock,
  scheduler,
  () => 'failure-match',
);

try {
  const created = await coordinator.create('host', 'create');
  assert.equal(created.outcome.status, 'accepted');

  const matchId = created.outcome.match.id;

  await coordinator.dispatch('player-A', 'join', {
    type: 'join',
    matchId,
  });

  console.log('--- START WITH BROKEN SCHEDULER ---');

  const started = await coordinator.dispatch('host', 'start', {
    type: 'start',
    matchId,
    questions,
  });

  const lookup = coordinator.lookup(matchId);
  assert.equal(lookup.status, 'found');

  const failures = coordinator.takeTimerFailures();

  console.log('Start status:', started.outcome.status);
  console.log('Match phase:', lookup.match.phase);
  console.log('Match version:', lookup.match.version);
  console.log('Scheduler calls:', scheduler.scheduleCalls);
  console.log('Timer failures:', failures.length);

  for (const failure of failures) {
    console.log('Failure matchId:', failure.matchId);
    console.log(
      'Failure message:',
      failure.error instanceof Error
        ? failure.error.message
        : failure.error,
    );
  }

  assert.equal(started.outcome.status, 'accepted');
  assert.equal(lookup.match.phase, 'QUESTION_OPEN');
  assert.equal(scheduler.scheduleCalls, 1);
  assert.equal(failures.length, 1);

  assert.equal(
    (failures[0]?.error as Error).message,
    'MANUAL_SCHEDULER_FAILURE',
  );

  // takeTimerFailures() should drain recorded failures.
  assert.equal(coordinator.takeTimerFailures().length, 0);

  console.log('\nSTEP 6A: FAILURE OBSERVABILITY VERIFIED');
} finally {
  await coordinator.shutdown();
}
