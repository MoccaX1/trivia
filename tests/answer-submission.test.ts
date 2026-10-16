import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMatch,
  joinMatch,
  startMatch,
  submitAnswer,
  questionDeadline,
} from '../src/domain/match-engine.js';
import type {
  MatchOutcome,
  MatchState,
  QuestionOpenMatch,
  RevealMatch,
  SubmitAnswerCommand,
} from '../src/domain/match-engine.js';

function opened(players = ['host', 'second']): QuestionOpenMatch {
  let match: MatchState = createMatch(players[0]!, () => 'match').match;
  for (const player of players.slice(1)) match = joinMatch(match, player).match;
  const questions = Array.from({ length: 10 }, (_, i) => ({
    id: `q${i}`,
    text: `Question ${i}`,
    choices: [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
      { id: 'c', text: 'C' },
    ],
    correctChoiceId: 'b',
  }));
  const result = startMatch(match, players[0]!, questions, 1_000);
  assert.ok(result.match.phase === 'QUESTION_OPEN');
  return result.match;
}

function command(choiceId = 'b'): SubmitAnswerCommand {
  return { matchId: 'match', questionId: 'q0', choiceId };
}

function answer(
  match: MatchState,
  player = 'host',
  choice = 'b',
  receivedAt = 2_000,
): QuestionOpenMatch {
  const result = submitAnswer(match, player, command(choice), receivedAt);
  assert.ok(result.status === 'accepted');
  assert.equal(result.changed, true);
  assert.ok(result.match.phase === 'QUESTION_OPEN');
  assert.equal(result.match.version, match.version + 1);
  return result.match;
}

function reveal(match: QuestionOpenMatch): RevealMatch {
  const result = questionDeadline(
    match,
    {
      matchId: match.id,
      questionId: match.currentQuestion.id,
      deadlineAt: match.currentQuestion.deadlineAt,
    },
    11_000,
  );
  assert.ok(result.status === 'accepted');
  assert.ok(result.match.phase === 'REVEAL');
  assert.equal(result.match.version, match.version + 1);
  return result.match;
}

function rejected(result: MatchOutcome, match: MatchState, code: string): void {
  assert.deepEqual(result, { status: 'rejected', match, code });
  assert.equal(result.match, match);
}

function score(match: RevealMatch, player = 'host'): bigint {
  const result = match.resolvedQuestions[0]!.results.find((entry) => entry.playerId === player);
  assert.ok(result);
  return result.questionScoreUnits;
}

test('first answer records trusted Player, choice, attempt and elapsed ingress milliseconds', () => {
  const original = opened();
  const before = structuredClone(original);
  const match = answer(original);
  assert.deepEqual(match.privateSubmissions, [
    { playerId: 'host', choiceId: 'b', attemptCount: 1, finalAnsweredMs: 1_000 },
  ]);
  assert.deepEqual(original, before);
  assert.equal(match.phase, 'QUESTION_OPEN');
  const resolved = reveal(match);
  assert.equal(score(resolved), 57_000_000n);
  assert.equal(score(resolved, 'second'), 0n);
  assert.deepEqual(resolved.resolvedQuestions[0]!.results[1], {
    playerId: 'second',
    submission: null,
    correct: false,
    questionScoreUnits: 0n,
  });
});

test('incorrect final choice and no answer score zero; resolved content retains authoritative answers', () => {
  const match = answer(opened(), 'host', 'a');
  const result = reveal(match);
  assert.equal(score(result), 0n);
  assert.equal(score(result, 'second'), 0n);
  const round = result.resolvedQuestions[0]!;
  assert.equal(round.questionIndex, 0);
  assert.equal(round.question.correctChoiceId, 'b');
  assert.deepEqual(round.results[0]!.submission, match.privateSubmissions[0]);
  assert.equal(round.results[0]!.correct, false);
});

test('accepted changes replace timing, reduce correctness component, and count a return to an earlier choice', () => {
  let match = answer(opened(), 'host', 'a', 1_000);
  match = answer(match, 'host', 'b', 3_000);
  assert.equal(score(reveal(match)), 39_000_000n);
  assert.deepEqual(match.privateSubmissions[0], {
    playerId: 'host',
    choiceId: 'b',
    attemptCount: 2,
    finalAnsweredMs: 2_000,
  });
  match = answer(match, 'host', 'a', 4_000);
  assert.equal(match.privateSubmissions[0]!.attemptCount, 3);
  assert.equal(score(reveal(match)), 0n);
  const before = structuredClone(match);
  rejected(submitAnswer(match, 'host', command('b'), 5_000), match, 'MAX_ATTEMPTS_EXCEEDED');
  assert.deepEqual(match, before);
});

test('third attempt may be correct; only the latest accepted different choice supplies scoring time', () => {
  let match = answer(opened(), 'host', 'a', 1_000);
  match = answer(match, 'host', 'c', 2_000);
  match = answer(match, 'host', 'b', 5_000);
  assert.equal(match.privateSubmissions[0]!.attemptCount, 3);
  assert.equal(score(reveal(match)), 28_000_000n);
});

test('same choice is an explicit accepted no-op, including after attempt exhaustion', () => {
  let match = answer(opened());
  for (const at of [3_000, 10_999]) {
    const before = structuredClone(match);
    assert.deepEqual(submitAnswer(match, 'host', command(), at), {
      status: 'accepted',
      changed: false,
      match,
    });
    assert.equal(submitAnswer(match, 'host', command(), at).match, match);
    assert.deepEqual(match, before);
    assert.equal(score(reveal(match)), 57_000_000n);
  }
  match = answer(match, 'host', 'a', 4_000);
  match = answer(match, 'host', 'b', 5_000);
  assert.deepEqual(submitAnswer(match, 'host', command(), 10_999), {
    status: 'accepted',
    changed: false,
    match,
  });
  assert.equal(score(reveal(match)), 28_000_000n);
});

test('phase, membership, Match, question and choice validate before any attempt is consumed', () => {
  const match = opened();
  const before = structuredClone(match);
  rejected(submitAnswer(match, 'outsider', command(), 2_000), match, 'NOT_MATCH_PARTICIPANT');
  rejected(
    submitAnswer(match, 'host', { ...command(), matchId: 'other' }, 2_000),
    match,
    'MATCH_ID_MISMATCH',
  );
  rejected(
    submitAnswer(match, 'host', { ...command(), questionId: 'q1' }, 2_000),
    match,
    'QUESTION_NOT_CURRENT',
  );
  rejected(submitAnswer(match, 'host', command('missing'), 2_000), match, 'INVALID_CHOICE');
  assert.deepEqual(match, before);
  const first = answer(match);
  assert.equal(first.privateSubmissions[0]!.attemptCount, 1);
  const firstBefore = structuredClone(first);
  rejected(submitAnswer(first, 'host', command('missing'), 3_000), first, 'INVALID_CHOICE');
  assert.deepEqual(first, firstBefore);
  const waiting = createMatch('host', () => 'waiting').match;
  rejected(submitAnswer(waiting, 'host', command(), 2_000), waiting, 'INVALID_MATCH_PHASE');
  const resolved = reveal(first);
  rejected(submitAnswer(resolved, 'host', command(), 2_000), resolved, 'INVALID_MATCH_PHASE');
});

test('exclusive deadline accepts millisecond 9999 and rejects exact deadline and later, even same-choice', () => {
  const initial = opened();
  const match = answer(initial, 'host', 'b', 10_999);
  assert.equal(score(reveal(match)), 30_003_000n);
  for (const at of [11_000, 11_001, 20_000]) {
    for (const state of [initial, match]) {
      const before = structuredClone(state);
      rejected(submitAnswer(state, 'host', command(), at), state, 'ANSWER_WINDOW_CLOSED');
      rejected(submitAnswer(state, 'host', command('a'), at), state, 'ANSWER_WINDOW_CLOSED');
      assert.deepEqual(state, before);
    }
  }
});

test('invalid authoritative timestamps reject before same-choice or attempt-limit branches', () => {
  const initial = opened();
  let exhausted = answer(initial, 'host', 'a');
  exhausted = answer(exhausted, 'host', 'c', 3_000);
  exhausted = answer(exhausted, 'host', 'b', 4_000);
  for (const state of [initial, exhausted]) {
    const before = structuredClone(state);
    for (const time of [999, NaN, Infinity, -Infinity, 1_000.5, Number.MAX_SAFE_INTEGER + 1]) {
      rejected(submitAnswer(state, 'host', command(), time), state, 'INVALID_TIMING');
      rejected(submitAnswer(state, 'host', command('a'), time), state, 'INVALID_TIMING');
    }
    assert.deepEqual(state, before);
  }
  assert.throws(() => submitAnswer(initial, '', command(), 2_000), TypeError);
});

test('all correctness penalties retain exact integer units at scoring boundaries, without a 9-second cutoff', () => {
  for (const [attempt, setup, base] of [
    [1, [] as string[], 30_000_000n],
    [2, ['a'], 15_000_000n],
    [3, ['a', 'c'], 10_000_000n],
  ] as const) {
    for (const [elapsed, speed] of [
      [0, 30_000_000n],
      [1, 29_997_000n],
      [9_000, 3_000_000n],
      [9_999, 3_000n],
    ] as const) {
      let match = opened();
      for (const choice of setup) match = answer(match, 'host', choice, 1_000);
      match = answer(match, 'host', 'b', 1_000 + elapsed);
      assert.equal(match.privateSubmissions[0]!.attemptCount, attempt);
      assert.equal(score(reveal(match)), base + speed);
    }
  }
});

test('Players answer independently; millisecond differences persist and exact score ties are preserved', () => {
  let match = opened(['host', 'second', 'third']);
  match = answer(match, 'host', 'b', 2_000);
  const first = match.privateSubmissions[0];
  match = answer(match, 'second', 'b', 2_001);
  match = answer(match, 'third', 'b', 2_000);
  assert.equal(match.privateSubmissions[0], first);
  const result = reveal(match);
  assert.equal(score(result, 'host') - score(result, 'second'), 3_000n);
  assert.equal(score(result, 'host'), score(result, 'third'));
  assert.equal(result.resolvedQuestions[0]!.results.length, 3);
});

test('answer and resolved result collections are deeply immutable, and timeout cannot score twice', () => {
  const match = answer(opened());
  const before = structuredClone(match);
  assert.throws(() => {
    (match.privateSubmissions as unknown[]).pop();
  }, TypeError);
  assert.throws(() => {
    (match.privateSubmissions[0]! as { choiceId: string }).choiceId = 'a';
  }, TypeError);
  const result = reveal(match);
  assert.throws(() => {
    (result.resolvedQuestions[0]!.results as unknown[]).pop();
  }, TypeError);
  assert.throws(() => {
    (
      result.resolvedQuestions[0]!.results[0]! as { questionScoreUnits: bigint }
    ).questionScoreUnits = 0n;
  }, TypeError);
  const resultBefore = structuredClone(result);
  rejected(
    questionDeadline(result, { matchId: 'match', questionId: 'q0', deadlineAt: 11_000 }, 12_000),
    result,
    'INVALID_MATCH_PHASE',
  );
  assert.deepEqual(result, resultBefore);
  assert.deepEqual(match, before);
});

test('submission overflow fails before mutation while same-choice no-op still succeeds', () => {
  const match = { ...answer(opened()), version: Number.MAX_SAFE_INTEGER };
  const before = structuredClone(match);
  assert.throws(
    () => submitAnswer(match, 'host', command('a'), 3_000),
    /version cannot advance safely/,
  );
  assert.deepEqual(submitAnswer(match, 'host', command(), 3_000), {
    status: 'accepted',
    changed: false,
    match,
  });
  assert.deepEqual(match, before);
});

test('Player IDs remain opaque and are supplied outside the answer payload', () => {
  const match = opened(['__proto__', 'constructor']);
  const answered = answer(match, '__proto__');
  assert.equal(answered.privateSubmissions[0]!.playerId, '__proto__');
  assert.equal(answered.privateSubmissions.length, 1);
});

test('equal exact units remain tied even with different attempts and millisecond timestamps', () => {
  let match = opened();
  match = answer(match, 'host', 'b', 6_000);
  match = answer(match, 'second', 'a', 1_000);
  match = answer(match, 'second', 'b', 1_000);
  const result = reveal(match);
  assert.equal(score(result, 'host'), 45_000_000n);
  assert.equal(score(result, 'second'), 45_000_000n);
});

test('client-shaped extra identity and score fields cannot override trusted caller identity or evaluation', () => {
  const match = opened();
  const forged = {
    ...command('a'),
    playerId: 'second',
    attemptCount: 1,
    isCorrect: true,
    score: 60,
  };
  const result = submitAnswer(match, 'host', forged, 2_000);
  assert.ok(result.match.phase === 'QUESTION_OPEN');
  assert.equal(result.match.privateSubmissions[0]!.playerId, 'host');
  const resolved = reveal(result.match);
  assert.equal(score(resolved, 'host'), 0n);
  assert.equal(resolved.resolvedQuestions[0]!.results[1]!.submission, null);
});
