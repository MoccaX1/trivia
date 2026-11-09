import { matchScoreboard } from '../domain/match-engine.js';
import type { MatchState, Submission } from '../domain/match-engine.js';
import type { PlayerProfile } from './authenticate-player.js';

interface ParticipantScore {
  playerId: string;
  displayName: string;
  score: { scoreUnits: string };
  rank: number;
}
interface PublicQuestion {
  questionId: string;
  text: string;
  choices: { choiceId: string; text: string }[];
}
interface OwnSubmission {
  choiceId: string;
  attemptCount: Submission['attemptCount'];
  finalAnsweredMs: number;
}
export type MatchSnapshot = { matchId: string; version: number } & (
  | {
      phase: 'QUESTION_OPEN';
      state: {
        questionNumber: number;
        questionCount: number;
        question: PublicQuestion;
        deadlineAt: string;
        participants: ParticipantScore[];
        ownSubmission?: OwnSubmission;
      };
    }
  | {
      phase: 'REVEAL';
      state: {
        questionNumber: number;
        questionCount: number;
        question: PublicQuestion & { correctChoiceId: string };
        revealEndsAt: string;
        participants: ParticipantScore[];
        ownResult: {
          selectedChoiceId?: string;
          correct: boolean;
          questionScore: { scoreUnits: string };
          attemptCount: 0 | 1 | 2 | 3;
          finalAnsweredMs?: number;
        };
      };
    }
  | { phase: 'FINISHED'; state: { participants: ParticipantScore[] } }
);

/** Internal state never crosses the wire; construct every field explicitly for this viewer. */
export function presentMatch(
  match: MatchState,
  profiles: readonly PlayerProfile[],
  viewerId: string,
): MatchSnapshot {
  if (match.phase === 'WAITING' || !match.participants.includes(viewerId))
    throw new TypeError('Active projection requires a participant');
  const names = new Map(profiles.map((profile) => [profile.id, profile.displayName]));
  if (profiles.length !== match.participants.length || names.size !== profiles.length)
    throw new Error('Incomplete Match profiles');
  const participants = matchScoreboard(match).map((entry) => {
    const displayName = names.get(entry.playerId);
    if (displayName === undefined) throw new Error('Missing Match profile');
    return {
      playerId: entry.playerId,
      displayName,
      score: { scoreUnits: entry.scoreUnits.toString() },
      rank: entry.rank,
    };
  });
  const envelope = { matchId: match.id, version: match.version };
  if (match.phase === 'FINISHED')
    return { ...envelope, phase: 'FINISHED', state: { participants } };
  const question: PublicQuestion = {
    questionId: match.currentQuestion.id,
    text: match.currentQuestion.text,
    choices: match.currentQuestion.choices.map((choice) => ({
      choiceId: choice.id,
      text: choice.text,
    })),
  };
  const questionNumber = match.currentQuestionIndex + 1,
    questionCount = 10;
  if (match.phase === 'QUESTION_OPEN') {
    const own = match.privateSubmissions.find((entry) => entry.playerId === viewerId);
    return {
      ...envelope,
      phase: 'QUESTION_OPEN',
      state: {
        questionNumber,
        questionCount,
        question,
        deadlineAt: new Date(match.currentQuestion.deadlineAt).toISOString(),
        participants,
        ...(own
          ? {
              ownSubmission: {
                choiceId: own.choiceId,
                attemptCount: own.attemptCount,
                finalAnsweredMs: own.finalAnsweredMs,
              },
            }
          : {}),
      },
    };
  }
  const own = match.resolvedQuestions[match.currentQuestionIndex]!.results.find(
    (entry) => entry.playerId === viewerId,
  )!;
  return {
    ...envelope,
    phase: 'REVEAL',
    state: {
      questionNumber,
      questionCount,
      question: { ...question, correctChoiceId: match.currentQuestion.correctChoiceId },
      revealEndsAt: new Date(match.revealDeadlineAt).toISOString(),
      participants,
      ownResult: {
        correct: own.correct,
        questionScore: { scoreUnits: own.questionScoreUnits.toString() },
        attemptCount: own.submission?.attemptCount ?? 0,
        ...(own.submission
          ? {
              selectedChoiceId: own.submission.choiceId,
              finalAnsweredMs: own.submission.finalAnsweredMs,
            }
          : {}),
      },
    },
  };
}
