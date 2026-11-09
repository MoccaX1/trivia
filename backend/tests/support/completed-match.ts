import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createMatch,
  joinMatch,
  startMatch,
  submitAnswer,
  questionDeadline,
  revealDeadline,
} from '../../src/domain/match-engine.js';
import type { MatchResult, MatchState } from '../../src/domain/match-engine.js';
import { demoQuestions } from '../../src/application/demo-questions.js';

export function completedResult(
  players: string[] = [randomUUID(), randomUUID(), randomUUID()],
  matchId: string = randomUUID(),
  elapsed = 1,
): MatchResult {
  let match: MatchState = createMatch(players[0]!, () => matchId).match;
  for (const player of players.slice(1)) match = joinMatch(match, player).match;
  match = startMatch(match, players[0]!, demoQuestions(), 1_700_000_000_123).match;
  for (let index = 0; index < 10; index++) {
    assert.ok(match.phase === 'QUESTION_OPEN');
    const opened = match.currentQuestion.openedAt;
    for (const player of players.slice(0, 2)) {
      assert.ok(match.phase === 'QUESTION_OPEN');
      match = submitAnswer(
        match,
        player,
        {
          matchId,
          questionId: match.currentQuestion.id,
          choiceId: match.currentQuestion.correctChoiceId,
        },
        opened + elapsed,
      ).match;
    }
    if (players[2] && index % 2 === 0) {
      assert.ok(match.phase === 'QUESTION_OPEN');
      const question = match.currentQuestion;
      const wrong = question.choices.find((c) => c.id !== question.correctChoiceId)!;
      match = submitAnswer(
        match,
        players[2],
        { matchId, questionId: match.currentQuestion.id, choiceId: wrong.id },
        opened + 2,
      ).match;
    }
    assert.ok(match.phase === 'QUESTION_OPEN');
    match = questionDeadline(
      match,
      {
        matchId,
        questionId: match.currentQuestion.id,
        deadlineAt: match.currentQuestion.deadlineAt,
      },
      match.currentQuestion.deadlineAt,
    ).match;
    assert.ok(match.phase === 'REVEAL');
    match = revealDeadline(
      match,
      { matchId, questionId: match.currentQuestion.id, deadlineAt: match.revealDeadlineAt },
      match.revealDeadlineAt,
    ).match;
  }
  assert.ok(match.phase === 'FINISHED');
  return match.result;
}
