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

class FakeScheduler implements MatchScheduler {
  tasks: { deadline: number; cancelled: boolean }[] = [];

  schedule(deadline: number, _callback: (error?: unknown) => void) {
    const task = { deadline, cancelled: false };
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

async function runCase(answerAt: number) {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler();
  const coordinator = new MatchCoordinator(
    clock,
    scheduler,
    () => `match-${answerAt}`,
  );

  try {
    const created = await coordinator.create('host', 'create');
    assert.equal(created.outcome.status, 'accepted');
    assert.ok('match' in created.outcome);

    const matchId = created.outcome.match.id;

    const joined = await coordinator.dispatch('player-A', 'join', {
      type: 'join',
      matchId,
    });
    assert.equal(joined.outcome.status, 'accepted');

    const started = await coordinator.dispatch('host', 'start', {
      type: 'start',
      matchId,
      questions,
    });

    assert.equal(started.outcome.status, 'accepted');
    assert.ok('match' in started.outcome);
    assert.equal(started.outcome.match.phase, 'QUESTION_OPEN');

    const match = started.outcome.match;
    assert.equal(match.phase, 'QUESTION_OPEN');

    const deadline = match.currentQuestion.deadlineAt;
    assert.equal(deadline, 10_000);

    // Admission: timestamp captured synchronously.
    clock.time = answerAt;
    const answerPromise = coordinator.dispatch('player-A', 'answer', {
      type: 'answer',
      matchId,
      questionId: 'q0',
      choiceId: 'b',
    });

    // No await between answer admission and deadline admission.
    clock.time = deadline;
    const timeoutPromise = coordinator.timeout({
      type: 'question-deadline',
      matchId,
      questionId: 'q0',
      deadlineAt: deadline,
    });

    const [answer, timeout] = await Promise.all([
      answerPromise,
      timeoutPromise,
    ]);

    const lookup = coordinator.lookup(matchId);
    assert.equal(lookup.status, 'found');

    console.log(`\n--- ANSWER AT ${answerAt} ms ---`);
    console.log('Answer receivedAt:', answer.receivedAt);
    console.log('Answer sequence:', answer.receiptSequence);
    console.log('Answer status:', answer.outcome.status);
    console.log(
      'Answer code:',
      answer.outcome.status === 'rejected'
        ? answer.outcome.code
        : '(none)',
    );
    console.log('Timeout sequence:', timeout.receiptSequence);
    console.log('Timeout status:', timeout.outcome.status);
    console.log('Final phase:', lookup.match.phase);

    assert.equal(answer.receivedAt, answerAt);
    assert.ok(answer.receiptSequence < timeout.receiptSequence);
    assert.equal(timeout.outcome.status, 'accepted');
    assert.equal(lookup.match.phase, 'REVEAL');

    if (answerAt === 9_999) {
      assert.equal(answer.outcome.status, 'accepted');
      assert.equal(answer.outcome.changed, true);
    } else {
      assert.equal(answer.outcome.status, 'rejected');
      assert.equal(answer.outcome.code, 'ANSWER_WINDOW_CLOSED');
    }

    console.log('RESULT: PASS');
  } finally {
    await coordinator.shutdown();
  }
}

await runCase(9_999);
await runCase(10_000);
console.log('\nSTEP 4A: ALL ASSERTIONS PASSED');
