import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMatch,
  joinMatch,
  startMatch,
  submitAnswer,
  questionDeadline,
  revealDeadline,
  matchScoreboard,
  validQuestionSet,
} from '../src/domain/match-engine.js';
import { demoQuestions } from '../src/application/demo-questions.js';
import { presentMatch } from '../src/application/match-presenter.js';

test('demo pack is meaningful, ordered, immutable, uniquely identified and Engine-valid', () => {
  const questions = demoQuestions();
  assert.equal(questions.length, 10);
  assert.equal(validQuestionSet(questions), true);
  assert.equal(new Set(questions.flatMap((q) => q.choices.map((c) => c.id))).size, 40);
  assert.ok(
    questions.every((q) => q.text.length > 20 && q.choices.every((c) => c.text.length > 0)),
  );
  assert.ok(
    Object.isFrozen(questions) &&
      questions.every((q) => Object.isFrozen(q) && Object.isFrozen(q.choices)),
  );
  assert.equal(demoQuestions(), questions);
  assert.equal(validQuestionSet(questions.slice(1)), false);
  assert.equal(
    validQuestionSet(questions.map((q, i) => (i === 0 ? { ...q, correctChoiceId: 'invalid' } : q))),
    false,
  );
});

test('active scoreboard sums resolved facts, preserves ties/gaps, and is reused at completion', () => {
  let match = createMatch('a', () => 'match').match;
  for (const id of ['b', 'c', 'd']) {
    const joined = joinMatch(match, id);
    assert.ok(joined.match.phase === 'WAITING');
    match = joined.match;
  }
  const started = startMatch(match, 'a', demoQuestions(), 0);
  let state = started.match;
  assert.deepEqual(
    matchScoreboard(state).map((e) => [e.scoreUnits, e.rank]),
    [
      [0n, 1],
      [0n, 1],
      [0n, 1],
      [0n, 1],
    ],
  );
  const profiles = ['a', 'b', 'c', 'd'].map((id) => ({ id, displayName: id }));
  for (let index = 0; index < 10; index++) {
    assert.ok(state.phase === 'QUESTION_OPEN');
    const opened = state.currentQuestion.openedAt;
    for (const [playerId, elapsed] of [
      ['a', 1],
      ['b', 1],
      ['c', 2],
    ] as const) {
      const answered = submitAnswer(
        state,
        playerId,
        {
          matchId: state.id,
          questionId: state.currentQuestion.id,
          choiceId: state.currentQuestion.correctChoiceId,
        },
        opened + elapsed,
      );
      state = answered.match;
      assert.ok(state.phase === 'QUESTION_OPEN');
    }
    assert.ok(state.phase === 'QUESTION_OPEN');
    const before = state,
      version = state.version;
    assert.equal(matchScoreboard(state)[0]!.scoreUnits, BigInt(index) * 59_997_000n);
    assert.equal(state, before);
    assert.equal(state.version, version);
    state = questionDeadline(
      state,
      {
        matchId: state.id,
        questionId: state.currentQuestion.id,
        deadlineAt: state.currentQuestion.deadlineAt,
      },
      state.currentQuestion.deadlineAt,
    ).match;
    assert.ok(state.phase === 'REVEAL');
    const board = matchScoreboard(state);
    assert.deepEqual(
      board.map((e) => e.rank),
      [1, 1, 3, 4],
    );
    assert.equal(board[0]!.scoreUnits, BigInt(index + 1) * 59_997_000n);
    assert.equal(board[2]!.scoreUnits, BigInt(index + 1) * 59_994_000n);
    assert.equal(board[3]!.scoreUnits, 0n);
    assert.ok(Object.isFrozen(board) && Object.isFrozen(board[0]));
    const projection = presentMatch(state, profiles, 'd');
    assert.ok(projection.phase === 'REVEAL');
    assert.deepEqual(projection.state.ownResult, {
      correct: false,
      questionScore: { scoreUnits: '0' },
      attemptCount: 0,
    });
    state = revealDeadline(
      state,
      {
        matchId: state.id,
        questionId: state.currentQuestion.id,
        deadlineAt: state.revealDeadlineAt,
      },
      state.revealDeadlineAt,
    ).match;
  }
  assert.ok(state.phase === 'FINISHED');
  assert.deepEqual(
    matchScoreboard(state).map((e) => e.scoreUnits),
    state.result.participants.map((e) => e.finalScoreUnits),
  );
  assert.deepEqual(
    matchScoreboard(state).map((e) => e.rank),
    [1, 1, 3, 4],
  );
  const final = presentMatch(state, profiles, 'a');
  assert.ok(final.phase === 'FINISHED');
  assert.deepEqual(Object.keys(final.state), ['participants']);
  assert.equal(final.state.participants[0]!.score.scoreUnits, '599970000');
  assert.throws(() => presentMatch(state, profiles, 'outsider'));
  assert.throws(() => presentMatch(state, [], 'a'));
});
