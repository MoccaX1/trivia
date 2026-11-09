import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMatch,
  joinMatch,
  leaveMatch,
  startMatch,
  questionDeadline,
} from '../src/domain/match-engine.js';
import type {
  MatchOutcome,
  MatchState,
  PrivateQuestion,
  QuestionDeadlineCommand,
  StartedMatch,
} from '../src/domain/match-engine.js';

function questions(): PrivateQuestion[] {
  return Array.from({ length: 10 }, (_, index) => ({
    id: `played-${index + 1}`,
    text: `Question ${index + 1}`,
    choices: [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
    ],
    correctChoiceId: 'b',
  }));
}

function waiting(): MatchState {
  return joinMatch(createMatch('host', () => 'match').match, 'second').match;
}

function started(): StartedMatch {
  const result = startMatch(waiting(), 'host', questions(), 1_000);
  assert.equal(result.status, 'accepted');
  assert.ok(result.match.phase === 'QUESTION_OPEN');
  return result.match;
}

function rejected(result: MatchOutcome, original: MatchState, code: string): void {
  assert.deepEqual(result, { status: 'rejected', match: original, code });
  assert.equal(result.match, original);
}

function timer(match: StartedMatch): QuestionDeadlineCommand {
  return {
    matchId: match.id,
    questionId: match.currentQuestion.id,
    deadlineAt: match.currentQuestion.deadlineAt,
  };
}

test('Host Start opens first supplied played question with authoritative timing and one new version', () => {
  const match = waiting();
  const before = structuredClone(match);
  const result = startMatch(match, 'host', questions(), 1_000);
  assert.equal(result.status, 'accepted');
  assert.ok(result.status === 'accepted');
  assert.equal(result.changed, true);
  assert.ok(result.match.phase === 'QUESTION_OPEN');
  assert.equal(result.match.version, 3);
  assert.equal(result.match.startedAt, 1_000);
  assert.equal(result.match.currentQuestionIndex, 0);
  assert.equal(result.match.currentQuestion.id, 'played-1');
  assert.equal(result.match.currentQuestion.openedAt, 1_000);
  assert.equal(result.match.currentQuestion.deadlineAt, 11_000);
  assert.equal(result.match.privateQuestions.length, 10);
  assert.equal(result.match.currentQuestion.correctChoiceId, 'b');
  assert.deepEqual(result.match.participants, match.participants);
  assert.deepEqual(match, before);
});

test('Start rejects unauthorized/nonparticipant Players and insufficient current membership', () => {
  const match = waiting();
  const before = structuredClone(match);
  rejected(startMatch(match, 'second', questions(), 0), match, 'NOT_HOST');
  rejected(startMatch(match, 'outsider', questions(), 0), match, 'NOT_MATCH_PARTICIPANT');
  assert.deepEqual(match, before);
  const alone = leaveMatch(match, 'second').match;
  rejected(startMatch(alone, 'host', questions(), 0), alone, 'INSUFFICIENT_PARTICIPANTS');
});

test('Start supports every approved participant count from 2 through 10', () => {
  let match = waiting();
  for (let count = 2; count <= 10; count++) {
    const result = startMatch(match, 'host', questions(), 0);
    assert.equal(result.status, 'accepted');
    assert.equal(result.match.participants.length, count);
    assert.equal(result.match.version, match.version + 1);
    if (count < 10) match = joinMatch(match, `player-${count}`).match;
  }
});

test('invalid supplied question sets reject before changing WAITING state', () => {
  const badSets: PrivateQuestion[][] = [questions().slice(1), [...questions(), questions()[0]!]];
  for (const change of [
    (q: PrivateQuestion[]) => {
      q[1] = q[0]!;
    },
    (q: PrivateQuestion[]) => {
      q[9] = { ...q[9]!, correctChoiceId: 'absent' };
    },
    (q: PrivateQuestion[]) => {
      q[0] = { ...q[0]!, choices: [] };
    },
    (q: PrivateQuestion[]) => {
      q[0] = { ...q[0]!, choices: [q[0]!.choices[0]!] };
    },
    (q: PrivateQuestion[]) => {
      q[0] = { ...q[0]!, choices: [q[0]!.choices[0]!, q[0]!.choices[0]!] };
    },
    (q: PrivateQuestion[]) => {
      q[0] = { ...q[0]!, id: '' };
    },
    (q: PrivateQuestion[]) => {
      q[0] = { ...q[0]!, text: '  ' };
    },
    (q: PrivateQuestion[]) => {
      q[0] = {
        ...q[0]!,
        choices: [
          { id: '', text: 'A' },
          { id: 'b', text: 'B' },
        ],
      };
    },
    (q: PrivateQuestion[]) => {
      q[0] = {
        ...q[0]!,
        choices: [
          { id: 'a', text: '' },
          { id: 'b', text: 'B' },
        ],
      };
    },
  ]) {
    const set = questions();
    change(set);
    badSets.push(set);
  }
  for (const set of badSets) {
    const match = waiting();
    const before = structuredClone(match);
    rejected(startMatch(match, 'host', set, 0), match, 'INVALID_QUESTION_SET');
    assert.deepEqual(match, before);
  }
});

test('Start rejects invalid clock values and deadline arithmetic overflow', () => {
  for (const time of [
    NaN,
    Infinity,
    -Infinity,
    0.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const match = waiting();
    rejected(startMatch(match, 'host', questions(), time), match, 'INVALID_TIMING');
  }
  // The clock origin is opaque, rather than assumed to be Unix epoch time.
  assert.equal(startMatch(waiting(), 'host', questions(), -100).status, 'accepted');
});

test('question deadline rejects just before boundary and reveals exactly at it', () => {
  const match = started();
  const before = structuredClone(match);
  const command = timer(match);
  rejected(questionDeadline(match, command, 10_999), match, 'DEADLINE_NOT_REACHED');
  assert.deepEqual(match, before);
  const result = questionDeadline(match, command, 11_000);
  assert.equal(result.status, 'accepted');
  assert.ok(result.match.phase === 'REVEAL');
  assert.equal(result.match.version, 4);
  assert.equal(result.match.revealOpenedAt, 11_000);
  assert.equal(result.match.revealDeadlineAt, 16_000);
  assert.equal(result.match.currentQuestion, match.currentQuestion);
  assert.deepEqual(match, before);
  rejected(questionDeadline(result.match, command, 11_000), result.match, 'INVALID_MATCH_PHASE');
  rejected(
    startMatch(result.match, 'host', questions(), 11_000),
    result.match,
    'INVALID_MATCH_PHASE',
  );
});

test('delayed deadline opens a full five-second reveal from actual authoritative transition time', () => {
  const match = started();
  const result = questionDeadline(match, timer(match), 20_000);
  assert.ok(result.match.phase === 'REVEAL');
  assert.equal(result.match.revealOpenedAt, 20_000);
  assert.equal(result.match.revealDeadlineAt, 25_000);
});

test('stale Match/question/deadline identities and invalid timing do not transition or advance version', () => {
  const match = started();
  const command = timer(match);
  const before = structuredClone(match);
  rejected(
    questionDeadline(match, { ...command, matchId: 'other' }, 11_000),
    match,
    'MATCH_ID_MISMATCH',
  );
  rejected(
    questionDeadline(match, { ...command, questionId: 'other' }, 11_000),
    match,
    'QUESTION_NOT_CURRENT',
  );
  rejected(
    questionDeadline(match, { ...command, deadlineAt: 11_001 }, 11_001),
    match,
    'DEADLINE_MISMATCH',
  );
  for (const time of [NaN, Infinity, 11_000.1, Number.MAX_SAFE_INTEGER]) {
    rejected(questionDeadline(match, command, time), match, 'INVALID_TIMING');
  }
  rejected(
    questionDeadline(match, { ...command, deadlineAt: NaN }, 11_000),
    match,
    'INVALID_TIMING',
  );
  assert.deepEqual(match, before);
});

test('Start repeats and lobby mutations on QUESTION_OPEN reject; deadlines in WAITING reject', () => {
  const match = started();
  const before = structuredClone(match);
  rejected(startMatch(match, 'host', questions(), 1_000), match, 'INVALID_MATCH_PHASE');
  rejected(joinMatch(match, 'third'), match, 'INVALID_MATCH_PHASE');
  rejected(leaveMatch(match, 'second'), match, 'INVALID_MATCH_PHASE');
  const lobby = waiting();
  rejected(questionDeadline(lobby, timer(match), 11_000), lobby, 'INVALID_MATCH_PHASE');
  assert.deepEqual(match, before);
});

test('private question content is copied and deeply frozen, including after reveal', () => {
  const source = questions();
  const result = startMatch(waiting(), 'host', source, 0);
  assert.ok(result.match.phase === 'QUESTION_OPEN');
  const match = result.match;
  (source[0]!.choices[0]! as { text: string }).text = 'changed';
  source[0] = { ...source[0]!, correctChoiceId: 'a' };
  assert.equal(match.currentQuestion.choices[0]!.text, 'A');
  assert.equal(match.currentQuestion.correctChoiceId, 'b');
  assert.throws(() => {
    (match.privateQuestions as PrivateQuestion[]).pop();
  }, TypeError);
  assert.throws(() => {
    (match.currentQuestion as { correctChoiceId: string }).correctChoiceId = 'a';
  }, TypeError);
  assert.throws(() => {
    (match.currentQuestion.choices[0]! as { text: string }).text = 'changed';
  }, TypeError);
  const reveal = questionDeadline(match, timer(match), 10_000).match;
  assert.ok(Object.isFrozen(reveal));
  assert.ok(Object.isFrozen(match.privateQuestions[9]!.choices));
});

test('Start and deadline transitions cannot overflow the Match version', () => {
  const waitingMax = { ...waiting(), version: Number.MAX_SAFE_INTEGER };
  const before = structuredClone(waitingMax);
  assert.throws(
    () => startMatch(waitingMax, 'host', questions(), 0),
    /version cannot advance safely/,
  );
  assert.deepEqual(waitingMax, before);
  const match = { ...started(), version: Number.MAX_SAFE_INTEGER };
  const activeBefore = structuredClone(match);
  assert.throws(
    () => questionDeadline(match, timer(match), 11_000),
    /version cannot advance safely/,
  );
  assert.deepEqual(match, activeBefore);
});
