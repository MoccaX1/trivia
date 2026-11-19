interface Participant {
  playerId: string;
  displayName: string;
}
interface Score {
  scoreUnits: string;
}
interface Standing extends Participant {
  score: Score;
  rank: number;
}
interface Question {
  questionId: string;
  text: string;
  choices: { choiceId: string; text: string }[];
}
type Round = { questionNumber: number; questionCount: number; participants: Standing[] };
interface LobbyRules {
  questionCount: number;
  answerWindowMs: number;
  revealDurationMs: number;
  allowAnswerChanges: boolean;
  maxAttempts: number;
  earlyClose: boolean;
}

export type MatchSnapshot = { matchId: string; version: number } & (
  | {
      phase: 'WAITING';
      state: { hostPlayerId: string; participants: Participant[]; rules: LobbyRules };
    }
  | {
      phase: 'QUESTION_OPEN';
      state: Round & {
        question: Question;
        deadlineAt: string;
        ownSubmission?: { choiceId: string; attemptCount: number; finalAnsweredMs: number };
      };
    }
  | {
      phase: 'REVEAL';
      state: Round & {
        question: Question & { correctChoiceId: string };
        revealEndsAt: string;
        ownResult: {
          selectedChoiceId?: string;
          correct: boolean;
          questionScore: Score;
          attemptCount: number;
          finalAnsweredMs?: number;
        };
      };
    }
  | { phase: 'FINISHED'; state: { participants: Standing[] } }
);

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim();
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function score(value: unknown): value is Score {
  return (
    record(value) &&
    typeof value['scoreUnits'] === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(value['scoreUnits'])
  );
}
function deadline(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Check the phase fields used by the client before consuming a server version. */
export function isMatchSnapshot(value: unknown, viewer: string): value is MatchSnapshot {
  if (!record(value) || !id(value['matchId']) || !integer(value['version'], 1)) return false;
  const state = value['state'];
  if (!record(state)) return false;
  const people: unknown = state['participants'];
  if (
    !Array.isArray(people) ||
    people.length > 10 ||
    !people.every((p) => record(p) && id(p['playerId']) && typeof p['displayName'] === 'string')
  )
    return false;
  const ids = new Set(people.map((p) => p['playerId']));
  if (ids.size !== people.length || !ids.has(viewer)) return false;
  const phase = value['phase'];
  if (phase === 'WAITING') {
    const rules = state['rules'];
    return (
      ids.has(state['hostPlayerId']) &&
      record(rules) &&
      rules['questionCount'] === 10 &&
      rules['answerWindowMs'] === 10000 &&
      rules['revealDurationMs'] === 5000 &&
      rules['maxAttempts'] === 3 &&
      rules['allowAnswerChanges'] === true &&
      rules['earlyClose'] === false
    );
  }
  if (!people.every((p) => score(p['score']) && integer(p['rank'], 1, people.length))) return false;
  if (phase === 'FINISHED') return true;
  if (phase !== 'QUESTION_OPEN' && phase !== 'REVEAL') return false;
  const question = state['question'];
  if (
    state['questionCount'] !== 10 ||
    !integer(state['questionNumber'], 1, 10) ||
    !record(question) ||
    !id(question['questionId']) ||
    typeof question['text'] !== 'string'
  )
    return false;
  const choices = question['choices'];
  if (
    !Array.isArray(choices) ||
    choices.length < 2 ||
    !choices.every(
      (choice) => record(choice) && id(choice['choiceId']) && typeof choice['text'] === 'string',
    )
  )
    return false;
  const choicesById = new Set(choices.map((choice) => choice['choiceId']));
  if (choicesById.size !== choices.length) return false;
  if (phase === 'QUESTION_OPEN') {
    const own = state['ownSubmission'];
    return (
      deadline(state['deadlineAt']) &&
      !('correctChoiceId' in question) &&
      !('ownResult' in state) &&
      (own === undefined ||
        (record(own) &&
          choicesById.has(own['choiceId']) &&
          integer(own['attemptCount'], 1, 3) &&
          integer(own['finalAnsweredMs'], 0, 9999)))
    );
  }
  const result = state['ownResult'];
  if (
    !deadline(state['revealEndsAt']) ||
    !choicesById.has(question['correctChoiceId']) ||
    !record(result) ||
    typeof result['correct'] !== 'boolean' ||
    !score(result['questionScore']) ||
    !integer(result['attemptCount'], 0, 3)
  )
    return false;
  return result['attemptCount'] === 0
    ? result['correct'] === false &&
        result['questionScore'].scoreUnits === '0' &&
        result['selectedChoiceId'] === undefined &&
        result['finalAnsweredMs'] === undefined
    : choicesById.has(result['selectedChoiceId']) && integer(result['finalAnsweredMs'], 0, 9999);
}
