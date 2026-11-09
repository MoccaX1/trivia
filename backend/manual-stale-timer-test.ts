import assert from 'node:assert/strict';
import { MatchCoordinator } from './src/application/match-coordinator.js';
import type { Clock, MatchScheduler } from './src/application/match-time.js';
import type { PrivateQuestion } from './src/domain/match-engine.js';

class FakeClock implements Clock {
  time = 0;
  now() {
    return this.time;
  }
}

class FakeScheduler implements MatchScheduler {
  tasks: {
    deadline: number;
    callback: (error?: unknown) => void;
    cancelled: boolean;
  }[] = [];

  schedule(deadline: number, callback: (error?: unknown) => void) {
    const task = { deadline, callback, cancelled: false };
    this.tasks.push(task);

    return () => {
      task.cancelled = true;
    };
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
const scheduler = new FakeScheduler();

const coordinator = new MatchCoordinator(
  clock,
  scheduler,
  () => 'stale-timer-match',
);

function snapshot() {
  const result = coordinator.lookup('stale-timer-match');
  assert.equal(result.status, 'found');
  return result.match;
}

try {
  await coordinator.create('host', 'create');

  await coordinator.dispatch('player-A', 'join', {
    type: 'join',
    matchId: 'stale-timer-match',
  });

  await coordinator.dispatch('host', 'start', {
    type: 'start',
    matchId: 'stale-timer-match',
    questions,
  });

  const timerA = scheduler.tasks[0];
  assert.ok(timerA);
  assert.equal(timerA.deadline, 10_000);

  // Timer A fires normally.
  clock.time = 10_000;
  timerA.callback();
  await coordinator.whenIdle('stale-timer-match');

  const afterA = snapshot();
  assert.equal(afterA.phase, 'REVEAL');

  const timerB = scheduler.tasks[1];
  assert.ok(timerB);
  assert.equal(timerB.deadline, 15_000);
  assert.equal(timerA.cancelled, true);

  console.log('--- AFTER TIMER A ---');
  console.log('Phase:', afterA.phase);
  console.log('Version:', afterA.version);
  console.log('Timer A cancelled:', timerA.cancelled);

  // Simulate a stale callback that runs despite cancellation.
  clock.time = 10_001;
  timerA.callback();
  await coordinator.whenIdle('stale-timer-match');

  const afterStale = snapshot();

  console.log('\n--- AFTER STALE TIMER A CALLBACK ---');
  console.log('Phase:', afterStale.phase);
  console.log('Version:', afterStale.version);
  console.log('Aggregate identity unchanged:', afterStale === afterA);
  console.log('Scheduled timer count:', scheduler.tasks.length);
  console.log('Timer B cancelled:', timerB.cancelled);

  assert.equal(afterStale.phase, 'REVEAL');
  assert.equal(afterStale.version, afterA.version);
  assert.equal(afterStale, afterA);
  assert.equal(scheduler.tasks.length, 2);
  assert.equal(timerB.cancelled, false);

  const probe = await coordinator.dispatch('player-A', 'probe-after-stale', {
    type: 'start-eligibility',
    matchId: 'stale-timer-match',
  });

  console.log('\n--- ADMISSION PROBE ---');
  console.log('Probe sequence:', probe.receiptSequence);
  console.log('Probe status:', probe.outcome.status);

  assert.equal(probe.receiptSequence, 6);

  // Verify the active reveal timer still works.
  clock.time = 15_000;
  timerB.callback();
  await coordinator.whenIdle('stale-timer-match');

  const afterB = snapshot();
  assert.equal(afterB.phase, 'QUESTION_OPEN');
  assert.equal(afterB.currentQuestion.id, 'q1');

  console.log('\n--- AFTER TIMER B ---');
  console.log('Phase:', afterB.phase);
  console.log('Question:', afterB.currentQuestion.id);
  console.log('Version:', afterB.version);

  console.log('\nSTEP 5: GAMEPLAY SAFETY ASSERTIONS PASSED');
} finally {
  await coordinator.shutdown();
}
