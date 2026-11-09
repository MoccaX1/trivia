import assert from 'node:assert/strict';
import { MatchCoordinator } from './src/application/match-coordinator.js';
import type { Clock, MatchScheduler } from './src/application/match-time.js';
import type { PrivateQuestion } from './src/domain/match-engine.js';

class FakeClock implements Clock {
  time = 0;
  now() { return this.time; }
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
    return () => { task.cancelled = true; };
  }
}

const questions: PrivateQuestion[] = Array.from(
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
  clock, scheduler, () => 'timer-match',
);

try {
  const created = await coordinator.create('host', 'create');
  assert.equal(created.outcome.status, 'accepted');
  const matchId = created.outcome.match.id;

  await coordinator.dispatch('player-A', 'join', {
    type: 'join', matchId,
  });

  const started = await coordinator.dispatch('host', 'start', {
    type: 'start', matchId, questions,
  });

  assert.equal(started.outcome.status, 'accepted');

  const first = scheduler.tasks[0];
  assert.ok(first);
  assert.equal(first.deadline, 10_000);

  console.log('Initial deadline:', first.deadline);

  // Early wakeup
  clock.time = 9_999;
  first.callback();
  await coordinator.whenIdle(matchId);

  assert.equal(coordinator.lookup(matchId).status, 'found');
  const early = coordinator.lookup(matchId);
  assert.equal(early.status, 'found');
  assert.equal(early.match.phase, 'QUESTION_OPEN');

  const second = scheduler.tasks[1];
  assert.ok(second);

  console.log('Phase at 9999:', early.match.phase);
  console.log('First timer cancelled:', first.cancelled);
  console.log('Rearmed deadline:', second.deadline);

  assert.equal(first.cancelled, true);
  assert.equal(second.deadline, 10_000);

  // Due callback
  clock.time = 10_000;
  second.callback();
  await coordinator.whenIdle(matchId);

  const due = coordinator.lookup(matchId);
  assert.equal(due.status, 'found');
  assert.equal(due.match.phase, 'REVEAL');

  const revealTimer = scheduler.tasks[2];
  assert.ok(revealTimer);
  assert.equal(revealTimer.deadline, 15_000);

  console.log('Phase at 10000:', due.match.phase);
  console.log('Second timer cancelled:', second.cancelled);
  console.log('Reveal deadline:', revealTimer.deadline);

  assert.equal(second.cancelled, true);

  console.log('\nSTEP 4B: ALL ASSERTIONS PASSED');
} finally {
  await coordinator.shutdown();
}
