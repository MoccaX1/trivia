import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMatch,
  joinMatch,
  leaveMatch,
  checkStartEligibility,
  startMatch,
  submitAnswer,
  questionDeadline,
  revealDeadline,
} from '../src/domain/match-engine.js';
import type {
  MatchState,
  MatchOutcome,
  QuestionOpenMatch,
  RevealMatch,
  FinishedMatch,
  RevealDeadlineCommand,
} from '../src/domain/match-engine.js';

function open(players = ['host', 'second']): QuestionOpenMatch {
  let match: MatchState = createMatch(players[0]!, () => 'match').match;
  for (const player of players.slice(1)) match = joinMatch(match, player).match;
  const questions = Array.from({ length: 10 }, (_, index) => ({
    id: `q${index}`,
    text: `Question ${index}`,
    choices: [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
    ],
    correctChoiceId: 'b',
  }));
  const result = startMatch(match, players[0]!, questions, 0);
  assert.ok(result.match.phase === 'QUESTION_OPEN');
  return result.match;
}

function close(match: QuestionOpenMatch): RevealMatch {
  const result = questionDeadline(
    match,
    {
      matchId: match.id,
      questionId: match.currentQuestion.id,
      deadlineAt: match.currentQuestion.deadlineAt,
    },
    match.currentQuestion.deadlineAt,
  );
  assert.ok(result.status === 'accepted');
  assert.ok(result.match.phase === 'REVEAL');
  assert.equal(result.match.version, match.version + 1);
  return result.match;
}

function command(match: RevealMatch): RevealDeadlineCommand {
  return {
    matchId: match.id,
    questionId: match.currentQuestion.id,
    deadlineAt: match.revealDeadlineAt,
  };
}

function advance(match: RevealMatch): MatchState {
  const result = revealDeadline(match, command(match), match.revealDeadlineAt);
  assert.ok(result.status === 'accepted');
  assert.equal(result.match.version, match.version + 1);
  return result.match;
}

function answer(
  match: QuestionOpenMatch,
  playerId: string,
  choiceId = 'b',
  elapsed = 0,
): QuestionOpenMatch {
  const result = submitAnswer(
    match,
    playerId,
    {
      matchId: match.id,
      questionId: match.currentQuestion.id,
      choiceId,
    },
    match.currentQuestion.openedAt + elapsed,
  );
  assert.ok(result.status === 'accepted');
  assert.ok(result.match.phase === 'QUESTION_OPEN');
  return result.match;
}

function complete(
  initial = open(),
  onQuestion = (match: QuestionOpenMatch) => match,
): FinishedMatch {
  let match = initial;
  for (let index = 0; index < 10; index++) {
    assert.equal(match.currentQuestionIndex, index);
    const next = advance(close(onQuestion(match)));
    if (index === 9) {
      assert.ok(next.phase === 'FINISHED');
      return next;
    }
    assert.ok(next.phase === 'QUESTION_OPEN');
    match = next;
  }
  throw new Error('Match did not finish');
}

function rejected(result: MatchOutcome, match: MatchState, code: string): void {
  assert.deepEqual(result, { status: 'rejected', match, code });
  assert.equal(result.match, match);
}

test('REVEAL advances once at exact boundary, resets submissions and preserves immutable history', () => {
  const first = close(answer(open(), 'host'));
  const before = structuredClone(first);
  rejected(
    revealDeadline(first, command(first), first.revealDeadlineAt - 1),
    first,
    'DEADLINE_NOT_REACHED',
  );
  const next = advance(first);
  assert.ok(next.phase === 'QUESTION_OPEN');
  assert.equal(next.currentQuestionIndex, 1);
  assert.equal(next.currentQuestion.id, 'q1');
  assert.equal(next.currentQuestion.openedAt, first.revealDeadlineAt);
  assert.equal(next.currentQuestion.deadlineAt, first.revealDeadlineAt + 10_000);
  assert.deepEqual(next.privateSubmissions, []);
  assert.equal(next.resolvedQuestions, first.resolvedQuestions);
  assert.equal(next.privateQuestions, first.privateQuestions);
  assert.equal(next.hostPlayerId, first.hostPlayerId);
  assert.deepEqual(next.participants, first.participants);
  rejected(
    revealDeadline(next, command(first), first.revealDeadlineAt),
    next,
    'INVALID_MATCH_PHASE',
  );
  const second = close(answer(next, 'second'));
  assert.equal(second.resolvedQuestions.length, 2);
  assert.equal(second.resolvedQuestions[0], first.resolvedQuestions[0]);
  assert.equal(second.resolvedQuestions[1]!.results[0]!.submission, null);
  assert.deepEqual(first, before);
});

test('all ten questions occur in order and produce one complete immutable MatchResult, never question 11', () => {
  const finished = complete();
  assert.equal(finished.version, 23);
  const result = finished.result;
  assert.equal(result.matchId, 'match');
  assert.equal(result.hostPlayerId, 'host');
  assert.equal(result.startedAt, 0);
  assert.equal(result.finishedAt, 150_000);
  assert.equal(result.resolvedQuestions.length, 10);
  assert.deepEqual(
    result.resolvedQuestions.map((q) => q.question.id),
    Array.from({ length: 10 }, (_, i) => `q${i}`),
  );
  result.resolvedQuestions.forEach((q, index) => {
    assert.equal(q.questionIndex, index);
    assert.equal(q.question.openedAt, index * 15_000);
    assert.equal(q.results.length, 2);
    assert.deepEqual(
      q.question.choices.map((choice) => choice.id),
      ['a', 'b'],
    );
    assert.equal(q.question.correctChoiceId, 'b');
    for (const player of q.results) {
      assert.equal(player.submission, null);
      assert.equal(player.questionScoreUnits, 0n);
    }
  });
  for (const player of result.participants) {
    assert.equal(player.finalScoreUnits, 0n);
    assert.equal(player.finalRank, 1);
  }
});

test('final scores sum exact awarded question units; incorrect and unanswered remain zero', () => {
  const finished = complete(open(['low', 'winner', 'wrong']), (match) => {
    let next = answer(match, 'winner', 'b', 0);
    next = answer(next, 'wrong', 'a', 0);
    if (match.currentQuestionIndex % 2 === 0) next = answer(next, 'low', 'b', 9_999);
    return next;
  });
  assert.deepEqual(finished.result.participants, [
    { playerId: 'low', finalScoreUnits: 150_015_000n, finalRank: 2 },
    { playerId: 'winner', finalScoreUnits: 600_000_000n, finalRank: 1 },
    { playerId: 'wrong', finalScoreUnits: 0n, finalRank: 3 },
  ]);
  for (const participant of finished.result.participants) {
    const sum = finished.result.resolvedQuestions.reduce(
      (total, question) =>
        total +
        question.results.find((entry) => entry.playerId === participant.playerId)!
          .questionScoreUnits,
      0n,
    );
    assert.equal(participant.finalScoreUnits, sum);
  }
});

test('stale identity, malformed timing, premature and duplicate timers preserve history and version', () => {
  const first = close(open());
  const before = structuredClone(first);
  const cmd = command(first);
  rejected(revealDeadline(first, { ...cmd, matchId: 'other' }, 15_000), first, 'MATCH_ID_MISMATCH');
  rejected(
    revealDeadline(first, { ...cmd, questionId: 'other' }, 15_000),
    first,
    'QUESTION_NOT_CURRENT',
  );
  rejected(
    revealDeadline(first, { ...cmd, deadlineAt: 15_001 }, 15_001),
    first,
    'DEADLINE_MISMATCH',
  );
  for (const time of [NaN, Infinity, -Infinity, 15_000.1, Number.MAX_SAFE_INTEGER]) {
    rejected(revealDeadline(first, cmd, time), first, 'INVALID_TIMING');
  }
  rejected(revealDeadline(first, { ...cmd, deadlineAt: NaN }, 15_000), first, 'INVALID_TIMING');
  const second = advance(first);
  assert.ok(second.phase === 'QUESTION_OPEN');
  const secondReveal = close(second);
  rejected(
    revealDeadline(secondReveal, cmd, secondReveal.revealDeadlineAt),
    secondReveal,
    'QUESTION_NOT_CURRENT',
  );
  rejected(
    questionDeadline(secondReveal, { ...cmd, deadlineAt: 10_000 }, 30_000),
    secondReveal,
    'INVALID_MATCH_PHASE',
  );
  assert.equal(secondReveal.resolvedQuestions.length, 2);
  assert.deepEqual(first, before);
});

test('delayed reveal transition starts next window at actual execution time', () => {
  const match = close(open());
  const result = revealDeadline(match, command(match), 20_000);
  assert.ok(result.match.phase === 'QUESTION_OPEN');
  assert.equal(result.match.currentQuestion.openedAt, 20_000);
  assert.equal(result.match.currentQuestion.deadlineAt, 30_000);
});

test('FINISHED rejects every gameplay command without changing completed facts or version', () => {
  const match = complete();
  const before = structuredClone(match);
  const cmd = { matchId: 'match', questionId: 'q9', deadlineAt: 150_000 };
  for (const result of [
    joinMatch(match, 'third'),
    leaveMatch(match, 'second'),
    checkStartEligibility(match, 'host'),
    startMatch(match, 'host', [], 150_000),
    submitAnswer(match, 'host', { ...cmd, choiceId: 'b' }, 140_000),
    questionDeadline(match, cmd, 150_000),
    revealDeadline(match, cmd, 150_000),
  ])
    rejected(result, match, 'MATCH_FINISHED');
  assert.deepEqual(match, before);
});

test('completed result and retained question/answer history are deeply immutable', () => {
  const match = complete(open(), (q) => answer(q, 'host'));
  const result = match.result;
  assert.throws(() => {
    (result as { finishedAt: number }).finishedAt = 0;
  }, TypeError);
  assert.throws(() => {
    (result.participants as unknown[]).pop();
  }, TypeError);
  assert.throws(() => {
    (result.participants[0]! as { finalRank: number }).finalRank = 10;
  }, TypeError);
  assert.throws(() => {
    (result.resolvedQuestions as unknown[]).pop();
  }, TypeError);
  assert.throws(() => {
    (result.resolvedQuestions[0]!.question.choices as unknown[]).pop();
  }, TypeError);
  assert.throws(() => {
    (result.resolvedQuestions[0]!.results[0]!.submission! as { choiceId: string }).choiceId = 'a';
  }, TypeError);
});

test('invalid internal question indices and history fail before mutation', () => {
  const initial = close(open());
  for (const change of [
    { currentQuestionIndex: -1 },
    { currentQuestionIndex: 10 },
    { currentQuestionIndex: 0.5 },
    { resolvedQuestions: [] },
    { resolvedQuestions: [...initial.resolvedQuestions, ...initial.resolvedQuestions] },
  ]) {
    const match = { ...initial, ...change } as RevealMatch;
    const before = structuredClone(match);
    assert.throws(
      () => revealDeadline(match, command(initial), 15_000),
      /question history invariant/,
    );
    assert.deepEqual(match, before);
  }
});

test('next-question and completion transitions guard version overflow; rejections at maximum stay nonmutating', () => {
  const first = { ...close(open()), version: Number.MAX_SAFE_INTEGER };
  const before = structuredClone(first);
  assert.throws(
    () => revealDeadline(first, command(first), first.revealDeadlineAt),
    /version cannot advance safely/,
  );
  rejected(
    revealDeadline(first, command(first), first.revealDeadlineAt - 1),
    first,
    'DEADLINE_NOT_REACHED',
  );
  assert.deepEqual(first, before);
  const penultimate = { ...first, version: Number.MAX_SAFE_INTEGER - 1 };
  assert.equal(advance(penultimate).version, Number.MAX_SAFE_INTEGER);
  let tenth = open();
  for (let i = 0; i < 9; i++) {
    const next = advance(close(tenth));
    assert.ok(next.phase === 'QUESTION_OPEN');
    tenth = next;
  }
  const final = { ...close(tenth), version: Number.MAX_SAFE_INTEGER };
  const finalBefore = structuredClone(final);
  assert.throws(
    () => revealDeadline(final, command(final), final.revealDeadlineAt),
    /version cannot advance safely/,
  );
  assert.deepEqual(final, finalBefore);
});

test('competition ranking preserves co-winners and skips occupied positions, independent of participant order', () => {
  const players = ['lower', 'tie-b', 'last', 'tie-a'];
  for (const order of [players, [...players].reverse()]) {
    const finished = complete(open(order), (match) => {
      let next = answer(match, 'tie-a', 'b', 0);
      next = answer(next, 'tie-b', 'b', 0);
      next = answer(next, 'lower', 'b', 1_000);
      return answer(next, 'last', 'b', 2_000);
    });
    const byPlayer = new Map(
      finished.result.participants.map((participant) => [participant.playerId, participant]),
    );
    assert.equal(byPlayer.get('tie-a')!.finalRank, 1);
    assert.equal(byPlayer.get('tie-b')!.finalRank, 1);
    assert.equal(byPlayer.get('lower')!.finalRank, 3);
    assert.equal(byPlayer.get('last')!.finalRank, 4);
    assert.equal(byPlayer.get('tie-a')!.finalScoreUnits, byPlayer.get('tie-b')!.finalScoreUnits);
  }
});

test('equal cumulative totals share rank despite different attempts and timestamps; lower ties skip positions', () => {
  const finished = complete(open(['slow', 'changed', 'wrong', 'unanswered', 'best']), (match) => {
    let next = answer(match, 'slow', 'b', 5_000);
    next = answer(next, 'changed', 'a', 0);
    next = answer(next, 'changed', 'b', 0);
    next = answer(next, 'wrong', 'a', 0);
    return answer(next, 'best', 'b', 0);
  });
  assert.deepEqual(
    finished.result.participants.map((p) => [p.playerId, p.finalScoreUnits, p.finalRank]),
    [
      ['slow', 450_000_000n, 2],
      ['changed', 450_000_000n, 2],
      ['wrong', 0n, 4],
      ['unanswered', 0n, 4],
      ['best', 600_000_000n, 1],
    ],
  );
});

test('completion retains actual execution time, final history and final representable version', () => {
  let question = open();
  for (let i = 0; i < 9; i++) {
    const next = advance(close(question));
    assert.ok(next.phase === 'QUESTION_OPEN');
    question = next;
  }
  const finalReveal = { ...close(question), version: Number.MAX_SAFE_INTEGER - 1 };
  const before = structuredClone(finalReveal);
  rejected(
    revealDeadline(finalReveal, command(finalReveal), finalReveal.revealDeadlineAt - 1),
    finalReveal,
    'DEADLINE_NOT_REACHED',
  );
  const result = revealDeadline(
    finalReveal,
    command(finalReveal),
    finalReveal.revealDeadlineAt + 3_000,
  );
  assert.ok(result.match.phase === 'FINISHED');
  assert.equal(result.match.version, Number.MAX_SAFE_INTEGER);
  assert.equal(result.match.result.finishedAt, 153_000);
  assert.equal(result.match.result.resolvedQuestions, finalReveal.resolvedQuestions);
  assert.deepEqual(finalReveal, before);
});
