import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchCoordinator } from '../src/application/match-coordinator.js';
import type { CommandReceipt, TimeoutCommand } from '../src/application/match-coordinator.js';
import { MatchRegistry } from '../src/application/match-registry.js';
import type { Clock, MatchScheduler } from '../src/application/match-time.js';
import { createMatch, joinMatch } from '../src/domain/match-engine.js';
import type { MatchState, PrivateQuestion } from '../src/domain/match-engine.js';

class FakeClock implements Clock {
  time = 0;
  fail = false;
  now() {
    if (this.fail) throw new Error('Clock failed');
    return this.time;
  }
}

class FakeScheduler implements MatchScheduler {
  tasks: {
    deadline: number;
    callback: (error?: unknown) => void;
    cancelled: boolean;
    fired: boolean;
  }[] = [];
  fail = false;
  failCancel = false;
  schedule(deadline: number, callback: (error?: unknown) => void) {
    if (this.fail) throw new Error('Scheduler failed');
    const task = { deadline, callback, cancelled: false, fired: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
      if (this.failCancel) throw new Error('Cancel failed');
    };
  }
  latest() {
    const task = this.tasks.at(-1);
    assert.ok(task);
    return task;
  }
  fire(task = this.latest()) {
    task.fired = true;
    task.callback();
  }
  active() {
    return this.tasks.filter((task) => !task.cancelled && !task.fired);
  }
}

const questions: readonly PrivateQuestion[] = Array.from({ length: 10 }, (_, i) => ({
  id: `q${i}`,
  text: `Question ${i}`,
  choices: [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
  ],
  correctChoiceId: 'b',
}));

function state(receipt: CommandReceipt): MatchState {
  assert.ok('match' in receipt.outcome);
  return receipt.outcome.match;
}

function setup(t: { after: (callback: () => Promise<void>) => void }) {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler();
  let generated = 0;
  const coordinator = new MatchCoordinator(clock, scheduler, () => `match-${++generated}`);
  t.after(() => coordinator.shutdown());
  return { clock, scheduler, coordinator };
}

async function lobby(coordinator: MatchCoordinator) {
  const created = await coordinator.create('host', 'create');
  const matchId = state(created).id;
  await coordinator.dispatch('second', 'join', { type: 'join', matchId });
  return matchId;
}

async function running(coordinator: MatchCoordinator) {
  const matchId = await lobby(coordinator);
  await coordinator.dispatch('host', 'start', { type: 'start', matchId, questions });
  return matchId;
}

function lookup(coordinator: MatchCoordinator, matchId: string): MatchState {
  const result = coordinator.lookup(matchId);
  assert.ok(result.status === 'found');
  return result.match;
}

test('Registry guards duplicate registration, stale updates and immutable aggregates; lookup is explicit', () => {
  const registry = new MatchRegistry();
  const match = createMatch('host', () => 'match').match;
  assert.deepEqual(registry.lookup('match'), {
    status: 'missing',
    code: 'MATCH_NOT_FOUND',
    matchId: 'match',
  });
  registry.register(match);
  assert.equal(registry.lookup('match').status, 'found');
  assert.throws(() => registry.register(match), /Duplicate/);
  const joined = joinMatch(match, 'second').match;
  registry.update(match, joined);
  assert.throws(() => registry.update(match, joined), /current aggregate/);
  assert.throws(() => registry.register({ ...match, id: 'mutable' }), /immutable/);
  const lookup = registry.lookup('match');
  assert.ok(lookup.status === 'found');
  assert.equal(lookup.match, joined);
  registry.close();
  assert.equal(registry.lookup('match').status, 'missing');
  assert.throws(() => registry.register(match), /closed/);
});

test('Create namespace and in-flight retries return their original outcome and register exactly once', async (t) => {
  const { coordinator } = setup(t);
  const first = coordinator.create('host', 'same');
  assert.equal(coordinator.create('host', 'same'), first);
  const created = await first;
  assert.equal(await coordinator.create('host', 'same'), created);
  const otherPlayer = await coordinator.create('second', 'same');
  assert.notEqual(state(otherPlayer).id, state(created).id);
  assert.ok(Object.isFrozen(created));
  assert.ok(Object.isFrozen(created.outcome));
});

test('Concurrent same-Match commands see committed latest state; namespaces are per Player and Match', async (t) => {
  const { coordinator, clock } = setup(t);
  const matchId = state(await coordinator.create('host', 'create')).id;
  clock.time = 1;
  const first = coordinator.dispatch('a', 'same', { type: 'join', matchId });
  clock.time = 2;
  const second = coordinator.dispatch('b', 'same', { type: 'join', matchId });
  assert.equal(coordinator.dispatch('a', 'same', { type: 'leave', matchId }), first);
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(
    [a.receivedAt, b.receivedAt, a.receiptSequence, b.receiptSequence],
    [1, 2, 2, 3],
  );
  assert.equal(state(a).version, 2);
  assert.equal(state(b).version, 3);
  assert.equal(lookup(coordinator, matchId), state(b));
  const other = state(await coordinator.create('host', 'other')).id;
  const joined = await coordinator.dispatch('a', 'same', { type: 'join', matchId: other });
  assert.equal(state(joined).id, other);
  assert.equal(state(joined).version, 2);
});

test('Rejections, unsupported and no-op commands preserve registered state and their cached outcomes', async (t) => {
  const { coordinator } = setup(t);
  const matchId = await lobby(coordinator);
  const original = lookup(coordinator, matchId);
  for (const [player, id, type, status] of [
    ['second', 'duplicate', 'join', 'rejected'],
    ['host', 'leave-host', 'leave', 'unsupported'],
    ['host', 'eligible', 'start-eligibility', 'accepted'],
  ] as const) {
    const receipt = await coordinator.dispatch(player, id, { type, matchId });
    assert.equal(receipt.outcome.status, status);
    assert.equal(lookup(coordinator, matchId), original);
    assert.equal(await coordinator.dispatch(player, id, { type: 'join', matchId }), receipt);
  }
  const missing = await coordinator.dispatch('host', 'missing', {
    type: 'join',
    matchId: 'absent',
  });
  assert.deepEqual(missing.outcome, {
    status: 'missing',
    code: 'MATCH_NOT_FOUND',
    matchId: 'absent',
  });
});

test('9999ms answer stays ahead of pending timeout despite delayed Engine execution', async (t) => {
  const { coordinator, clock, scheduler } = setup(t);
  const matchId = await running(coordinator);
  const timer = scheduler.latest();
  clock.time = 9_999;
  const answer = coordinator.dispatch('host', 'answer', {
    type: 'answer',
    matchId,
    questionId: 'q0',
    choiceId: 'b',
  });
  clock.time = 10_000;
  scheduler.fire(timer);
  clock.time = 20_000; // Both queued, neither Engine operation has executed.
  assert.equal((await answer).outcome.status, 'accepted');
  await coordinator.whenIdle(matchId);
  const match = lookup(coordinator, matchId);
  assert.ok(match.phase === 'REVEAL');
  assert.equal(match.privateSubmissions[0]!.finalAnsweredMs, 9_999);
  assert.equal(match.resolvedQuestions[0]!.results[0]!.questionScoreUnits, 30_003_000n);
  assert.equal(match.revealOpenedAt, 20_000);
  assert.equal(match.revealDeadlineAt, 25_000);
  assert.ok(timer.cancelled);
  assert.equal(scheduler.active().length, 1);
});

for (const ingress of [10_000, 10_001]) {
  test(`answer at ${ingress}ms rejects even before the timer callback executes`, async (t) => {
    const { coordinator, clock } = setup(t);
    const matchId = await running(coordinator);
    const original = lookup(coordinator, matchId);
    clock.time = ingress;
    const receipt = await coordinator.dispatch('host', 'late', {
      type: 'answer',
      matchId,
      questionId: 'q0',
      choiceId: 'b',
    });
    assert.ok(receipt.outcome.status === 'rejected');
    assert.equal(receipt.outcome.code, 'ANSWER_WINDOW_CLOSED');
    assert.equal(lookup(coordinator, matchId), original);
  });
}

test('duplicate/stale timer callbacks cannot duplicate transitions; stale deadline identity is rejected by Engine', async (t) => {
  const { coordinator, clock, scheduler } = setup(t);
  const matchId = await running(coordinator);
  const old = scheduler.latest();
  clock.time = 10_001;
  const wrong: TimeoutCommand = {
    type: 'question-deadline',
    matchId,
    questionId: 'q0',
    deadlineAt: 10_001,
  };
  const mismatch = await coordinator.timeout(wrong);
  assert.ok(mismatch.outcome.status === 'rejected');
  assert.equal(mismatch.outcome.code, 'DEADLINE_MISMATCH');
  scheduler.fire(old);
  scheduler.fire(old);
  await coordinator.whenIdle(matchId);
  const revealed = lookup(coordinator, matchId);
  assert.ok(revealed.phase === 'REVEAL');
  assert.equal(revealed.version, 4);
  assert.equal(revealed.resolvedQuestions.length, 1);
  clock.time = revealed.revealDeadlineAt;
  scheduler.fire();
  await coordinator.whenIdle(matchId);
  const next = lookup(coordinator, matchId);
  assert.ok(next.phase === 'QUESTION_OPEN');
  assert.equal(next.currentQuestionIndex, 1);
  scheduler.fire(old);
  await coordinator.whenIdle(matchId);
  assert.equal(lookup(coordinator, matchId), next);
  assert.deepEqual(coordinator.takeTimerFailures(), []);
});

test('early callbacks rearm without admission; explicit premature timeout is invalid application input', async (t) => {
  const { coordinator, clock, scheduler } = setup(t);
  const matchId = await running(coordinator);
  const original = lookup(coordinator, matchId);
  clock.time = 9_999;
  scheduler.fire();
  await coordinator.whenIdle(matchId);
  assert.equal(lookup(coordinator, matchId), original);
  assert.equal(scheduler.active().length, 1);
  assert.throws(
    () =>
      coordinator.timeout({
        type: 'question-deadline',
        matchId,
        questionId: 'q0',
        deadlineAt: 10_000,
      }),
    RangeError,
  );
  clock.time = 10_000;
  scheduler.fire();
  await coordinator.whenIdle(matchId);
  assert.equal(lookup(coordinator, matchId).phase, 'REVEAL');
});

test('rejected Engine exception cannot poison its queue or block an independent Match', async (t) => {
  const { coordinator } = setup(t);
  const matchId = await lobby(coordinator);
  const other = state(await coordinator.create('other', 'create')).id;
  const before = lookup(coordinator, matchId);
  const invalid = Array.from({ length: 10 }, (_, i) => ({
    id: `q${i}`,
    text: 'Q',
  })) as unknown as PrivateQuestion[];
  const failed = coordinator.dispatch('host', 'start', {
    type: 'start',
    matchId,
    questions: invalid,
  });
  const joined = coordinator.dispatch('third', 'join', { type: 'join', matchId });
  const independent = coordinator.dispatch('other-guest', 'join', { type: 'join', matchId: other });
  await assert.rejects(failed, TypeError);
  assert.equal(state(await joined).version, before.version + 1);
  assert.equal(state(await independent).version, 2);
  const retried = await coordinator.dispatch('host', 'start', {
    type: 'start',
    matchId,
    questions,
  });
  assert.equal(state(retried).phase, 'QUESTION_OPEN');
});

test('input snapshots and separate trusted identity prevent caller mutation while queued', async (t) => {
  const { coordinator, clock } = setup(t);
  const matchId = await running(coordinator);
  clock.time = 1_000;
  const command = {
    type: 'answer' as const,
    matchId,
    questionId: 'q0',
    choiceId: 'b',
    playerId: 'second',
    receivedAt: 0,
  };
  const receipt = coordinator.dispatch('host', 'answer', command);
  command.choiceId = 'a';
  const match = state(await receipt);
  assert.ok(match.phase === 'QUESTION_OPEN');
  assert.deepEqual(match.privateSubmissions[0], {
    playerId: 'host',
    choiceId: 'b',
    attemptCount: 1,
    finalAnsweredMs: 1_000,
  });
});

test('timer failures are observable with no unhandled rejection and retain consistent pre-commit state', async (t) => {
  const { coordinator, clock, scheduler } = setup(t);
  const matchId = await running(coordinator);
  const original = lookup(coordinator, matchId);
  clock.time = 10_000;
  scheduler.fire();
  clock.fail = true; // Failure at serialized execution, after successful timer admission.
  await coordinator.whenIdle(matchId);
  clock.fail = false;
  assert.equal(lookup(coordinator, matchId), original);
  const failures = coordinator.takeTimerFailures();
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]!.error), /Clock failed/);
  assert.deepEqual(coordinator.takeTimerFailures(), []);
  const result = await coordinator.timeout({
    type: 'question-deadline',
    matchId,
    questionId: 'q0',
    deadlineAt: 10_000,
  });
  assert.equal(state(result).phase, 'REVEAL');
});

test('post-commit scheduling failure is reported without replaying the committed mutation', async (t) => {
  const { coordinator, scheduler } = setup(t);
  const matchId = await lobby(coordinator);
  scheduler.fail = true;
  const result = await coordinator.dispatch('host', 'start', { type: 'start', matchId, questions });
  assert.equal(lookup(coordinator, matchId), state(result));
  assert.equal(state(result).phase, 'QUESTION_OPEN');
  assert.equal(coordinator.takeTimerFailures().length, 1);
  assert.equal(
    await coordinator.dispatch('host', 'start', { type: 'start', matchId, questions }),
    result,
  );
});

test('FINISHED cancels timers, retains aggregate and original retry receipts, and rejects stale gameplay', async (t) => {
  const { coordinator, scheduler, clock } = setup(t);
  const matchId = await running(coordinator);
  const created = await coordinator.create('host', 'create');
  const answer = await coordinator.dispatch('host', 'answer', {
    type: 'answer',
    matchId,
    questionId: 'q0',
    choiceId: 'b',
  });
  const old = scheduler.latest();
  for (let i = 0; i < 20; i++) {
    clock.time = scheduler.latest().deadline;
    scheduler.fire();
    await coordinator.whenIdle(matchId);
  }
  const finished = lookup(coordinator, matchId);
  assert.ok(finished.phase === 'FINISHED');
  assert.equal(finished.result.resolvedQuestions.length, 10);
  assert.equal(scheduler.active().length, 0);
  assert.equal(await coordinator.create('host', 'create'), created);
  assert.equal(
    await coordinator.dispatch('host', 'answer', {
      type: 'answer',
      matchId,
      questionId: 'q0',
      choiceId: 'a',
    }),
    answer,
  );
  scheduler.fire(old);
  await coordinator.whenIdle(matchId);
  assert.equal(lookup(coordinator, matchId), finished);
  const late = await coordinator.dispatch('second', 'late', { type: 'join', matchId });
  assert.ok(late.outcome.status === 'rejected');
  assert.equal(late.outcome.code, 'MATCH_FINISHED');
});

test('shutdown drains admitted work, cancels deadlines, clears retained state and refuses new admissions', async (t) => {
  const { coordinator, scheduler } = setup(t);
  const matchId = await running(coordinator);
  const pending = coordinator.dispatch('host', 'eligible', { type: 'start-eligibility', matchId });
  const shutdown = coordinator.shutdown();
  assert.equal(coordinator.shutdown(), shutdown);
  await pending;
  await shutdown;
  assert.equal(scheduler.active().length, 0);
  assert.equal(coordinator.lookup(matchId).status, 'missing');
  scheduler.fire();
  await coordinator.whenIdle(matchId);
  assert.throws(() => coordinator.create('host', 'new'), /closed/);
});

test('shutdown also waits for admitted Create; duplicate generated IDs fail without overwriting', async () => {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler();
  const coordinator = new MatchCoordinator(clock, scheduler, () => 'fixed');
  const first = await coordinator.create('host', 'first');
  await assert.rejects(coordinator.create('second', 'second'), /Duplicate/);
  assert.equal(lookup(coordinator, 'fixed'), state(first));
  await coordinator.shutdown();
  const fresh = new MatchCoordinator(clock, scheduler, () => 'fresh');
  const pending = fresh.create('host', 'new');
  const shutdown = fresh.shutdown();
  assert.equal(state(await pending).id, 'fresh');
  await shutdown;
  assert.equal(fresh.lookup('fresh').status, 'missing');
});

test('invalid trusted application input is distinct from domain rejection and missing Matches', async (t) => {
  const { coordinator, clock } = setup(t);
  assert.throws(() => coordinator.create('', 'id'), TypeError);
  assert.throws(
    () => coordinator.dispatch('host', '', { type: 'join', matchId: 'match' }),
    TypeError,
  );
  clock.time = NaN;
  assert.throws(() => coordinator.create('host', 'create'), TypeError);
  clock.time = 0;
  assert.throws(
    () =>
      coordinator.timeout({
        type: 'question-deadline',
        matchId: 'match',
        questionId: 'q0',
        deadlineAt: NaN,
      }),
    TypeError,
  );
});

test('answer mutations and same-choice no-ops leave the authoritative timer unchanged', async (t) => {
  const { coordinator, scheduler, clock } = setup(t);
  const matchId = await running(coordinator);
  const originalTimer = scheduler.latest();
  clock.time = 1_000;
  const first = await coordinator.dispatch('host', 'one', {
    type: 'answer',
    matchId,
    questionId: 'q0',
    choiceId: 'b',
  });
  const before = lookup(coordinator, matchId);
  clock.time = 2_000;
  const noop = await coordinator.dispatch('host', 'two', {
    type: 'answer',
    matchId,
    questionId: 'q0',
    choiceId: 'b',
  });
  assert.ok(noop.outcome.status === 'accepted');
  assert.equal(noop.outcome.changed, false);
  assert.equal(state(noop), state(first));
  assert.equal(lookup(coordinator, matchId), before);
  assert.equal(scheduler.latest(), originalTimer);
  assert.equal(scheduler.tasks.length, 1);
});

test('Start and delayed reveal callbacks use execution time, separately from ingress and due time', async (t) => {
  const { coordinator, clock, scheduler } = setup(t);
  const matchId = await lobby(coordinator);
  clock.time = 5;
  const pending = coordinator.dispatch('host', 'start', { type: 'start', matchId, questions });
  clock.time = 100;
  const started = await pending;
  const initial = state(started);
  assert.ok(initial.phase === 'QUESTION_OPEN');
  assert.equal(started.receivedAt, 5);
  assert.equal(initial.currentQuestion.openedAt, 100);
  clock.time = 10_100;
  scheduler.fire();
  clock.time = 11_000;
  await coordinator.whenIdle(matchId);
  const revealed = lookup(coordinator, matchId);
  assert.ok(revealed.phase === 'REVEAL');
  assert.equal(revealed.revealOpenedAt, 11_000);
  assert.equal(scheduler.latest().deadline, 16_000);
  clock.time = 16_000;
  scheduler.fire();
  clock.time = 17_000;
  await coordinator.whenIdle(matchId);
  const next = lookup(coordinator, matchId);
  assert.ok(next.phase === 'QUESTION_OPEN');
  assert.equal(next.currentQuestion.openedAt, 17_000);
  assert.equal(next.currentQuestion.deadlineAt, 27_000);
});

test('cancellation and callback infrastructure errors are reported without interrupting cleanup or state ownership', async (t) => {
  const { coordinator, clock, scheduler } = setup(t);
  const matchId = await running(coordinator);
  const before = lookup(coordinator, matchId);
  scheduler.latest().callback(new Error('Adapter failed'));
  assert.equal(lookup(coordinator, matchId), before);
  assert.match(String(coordinator.takeTimerFailures()[0]!.error), /Adapter failed/);
  scheduler.failCancel = true;
  clock.time = 10_000;
  scheduler.fire();
  await coordinator.whenIdle(matchId);
  assert.equal(lookup(coordinator, matchId).phase, 'REVEAL');
  assert.equal(scheduler.active().length, 1);
  assert.match(String(coordinator.takeTimerFailures()[0]!.error), /Cancel failed/);
  await coordinator.shutdown();
  assert.equal(scheduler.active().length, 0);
  assert.match(String(coordinator.takeTimerFailures()[0]!.error), /Cancel failed/);
});
