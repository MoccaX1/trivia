export type PlayerId = string;
export type MatchId = string;

interface MatchIdentity {
  readonly id: MatchId;
  readonly hostPlayerId: PlayerId;
  readonly participants: readonly PlayerId[];
  readonly version: number;
}

export interface WaitingMatch extends MatchIdentity {
  readonly phase: 'WAITING';
}

export interface Choice {
  readonly id: string;
  readonly text: string;
}

/** Internal authoritative content, never a client DTO or command acknowledgement. */
export interface PrivateQuestion {
  readonly id: string;
  readonly text: string;
  readonly choices: readonly Choice[];
  readonly correctChoiceId: string;
}

interface StartedMatchState extends MatchIdentity {
  readonly startedAt: number;
  readonly privateQuestions: readonly PrivateQuestion[];
  readonly currentQuestionIndex: 0;
  readonly currentQuestion: PrivateQuestion & {
    readonly openedAt: number;
    readonly deadlineAt: number;
  };
}

export interface QuestionOpenMatch extends StartedMatchState {
  readonly phase: 'QUESTION_OPEN';
}

export interface RevealMatch extends StartedMatchState {
  readonly phase: 'REVEAL';
  readonly revealOpenedAt: number;
  readonly revealDeadlineAt: number;
}

export type StartedMatch = QuestionOpenMatch | RevealMatch;

export type MatchState = WaitingMatch | StartedMatch;

export interface QuestionDeadlineCommand {
  readonly matchId: MatchId;
  readonly questionId: string;
  readonly deadlineAt: number;
}

type RejectionCode =
  | 'INVALID_MATCH_PHASE'
  | 'MATCH_FINISHED'
  | 'ALREADY_MATCH_PARTICIPANT'
  | 'MATCH_FULL'
  | 'NOT_MATCH_PARTICIPANT'
  | 'NOT_HOST'
  | 'INSUFFICIENT_PARTICIPANTS'
  | 'INVALID_QUESTION_SET'
  | 'INVALID_TIMING'
  | 'MATCH_ID_MISMATCH'
  | 'QUESTION_NOT_CURRENT'
  | 'DEADLINE_MISMATCH'
  | 'DEADLINE_NOT_REACHED';

export type MatchOutcome<T extends MatchState = MatchState> =
  | { readonly status: 'accepted'; readonly match: T; readonly changed: boolean }
  | { readonly status: 'rejected'; readonly match: T; readonly code: RejectionCode }
  | {
      readonly status: 'unsupported';
      readonly match: T;
      readonly reason: 'HOST_DEPARTURE_DEFERRED';
    };

export type LobbyOutcome = MatchOutcome<WaitingMatch>;

function assertIdentity(identity: string): void {
  if (typeof identity !== 'string' || identity.trim().length === 0) {
    throw new TypeError('Expected a nonblank server-resolved identity');
  }
}

function freezeMatch(match: WaitingMatch): WaitingMatch {
  return Object.freeze({ ...match, participants: Object.freeze([...match.participants]) });
}

function nextVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 1 || version === Number.MAX_SAFE_INTEGER) {
    throw new Error('Match version cannot advance safely');
  }
  return version + 1;
}

/** The caller supplies trusted Player identity and a server-owned ID generator, never client IDs. */
export function createMatch(
  playerId: PlayerId,
  generateMatchId: () => MatchId,
): Extract<LobbyOutcome, { status: 'accepted' }> {
  assertIdentity(playerId);
  const id = generateMatchId();
  assertIdentity(id);
  return {
    status: 'accepted',
    changed: true,
    match: freezeMatch({
      id,
      hostPlayerId: playerId,
      phase: 'WAITING',
      participants: [playerId],
      version: 1,
    }),
  };
}

function reject<T extends MatchState>(match: T, code: RejectionCode): MatchOutcome<T> {
  return { status: 'rejected', match, code };
}

function validateWaiting(match: MatchState, playerId: PlayerId): MatchOutcome | undefined {
  // Invalid trusted identities/internal aggregates are programming failures, not authentication outcomes.
  assertIdentity(playerId);
  const phase: string = match.phase;
  if (phase !== 'WAITING') {
    return reject(match, phase === 'FINISHED' ? 'MATCH_FINISHED' : 'INVALID_MATCH_PHASE');
  }
  if (
    match.participants.length < 1 ||
    match.participants.length > 10 ||
    !match.participants.includes(match.hostPlayerId) ||
    new Set(match.participants).size !== match.participants.length ||
    !Number.isSafeInteger(match.version) ||
    match.version < 1
  ) {
    throw new Error('Invalid WAITING Match invariant');
  }
}

export function joinMatch(match: MatchState, playerId: PlayerId): MatchOutcome {
  const invalid = validateWaiting(match, playerId);
  if (invalid) return invalid;
  if (match.phase !== 'WAITING') return reject(match, 'INVALID_MATCH_PHASE');
  if (match.participants.includes(playerId)) return reject(match, 'ALREADY_MATCH_PARTICIPANT');
  if (match.participants.length === 10) return reject(match, 'MATCH_FULL');
  return {
    status: 'accepted',
    changed: true,
    match: freezeMatch({
      ...match,
      participants: [...match.participants, playerId],
      version: nextVersion(match.version),
    }),
  };
}

export function leaveMatch(match: MatchState, playerId: PlayerId): MatchOutcome {
  const invalid = validateWaiting(match, playerId);
  if (invalid) return invalid;
  if (match.phase !== 'WAITING') return reject(match, 'INVALID_MATCH_PHASE');
  if (!match.participants.includes(playerId)) return reject(match, 'NOT_MATCH_PARTICIPANT');
  if (playerId === match.hostPlayerId) {
    return { status: 'unsupported', match, reason: 'HOST_DEPARTURE_DEFERRED' };
  }
  return {
    status: 'accepted',
    changed: true,
    match: freezeMatch({
      ...match,
      participants: match.participants.filter((participant) => participant !== playerId),
      version: nextVersion(match.version),
    }),
  };
}

/** Eligibility only: this does not execute Start or open a question. */
export function checkStartEligibility(match: MatchState, playerId: PlayerId): MatchOutcome {
  const invalid = validateWaiting(match, playerId);
  if (invalid) return invalid;
  if (match.phase !== 'WAITING') return reject(match, 'INVALID_MATCH_PHASE');
  if (!match.participants.includes(playerId)) return reject(match, 'NOT_MATCH_PARTICIPANT');
  if (playerId !== match.hostPlayerId) return reject(match, 'NOT_HOST');
  if (match.participants.length < 2) return reject(match, 'INSUFFICIENT_PARTICIPANTS');
  return { status: 'accepted', changed: false, match };
}

function validTime(time: number): boolean {
  return Number.isSafeInteger(time);
}

function deadlineAfter(time: number, duration: number): number | undefined {
  const deadline = time + duration;
  return validTime(time) && validTime(deadline) ? deadline : undefined;
}

function validQuestionSet(questions: readonly PrivateQuestion[]): boolean {
  const nonblank = (value: string) => typeof value === 'string' && value.trim().length > 0;
  return (
    questions.length === 10 &&
    new Set(questions.map((question) => question.id)).size === 10 &&
    questions.every(
      (question) =>
        nonblank(question.id) &&
        nonblank(question.text) &&
        question.choices.length >= 2 &&
        new Set(question.choices.map((choice) => choice.id)).size === question.choices.length &&
        question.choices.every((choice) => nonblank(choice.id) && nonblank(choice.text)) &&
        question.choices.some((choice) => choice.id === question.correctChoiceId),
    )
  );
}

/** Questions are already selected and ordered by the server; openedAt is its authoritative Clock reading. */
export function startMatch(
  match: MatchState,
  playerId: PlayerId,
  questions: readonly PrivateQuestion[],
  openedAt: number,
): MatchOutcome {
  const eligibility = checkStartEligibility(match, playerId);
  if (eligibility.status !== 'accepted') return eligibility;
  if (match.phase !== 'WAITING') return reject(match, 'INVALID_MATCH_PHASE');
  if (!validQuestionSet(questions)) return reject(match, 'INVALID_QUESTION_SET');
  const deadlineAt = deadlineAfter(openedAt, 10_000);
  if (deadlineAt === undefined) return reject(match, 'INVALID_TIMING');
  const version = nextVersion(match.version);
  const privateQuestions = Object.freeze(
    questions.map((question) =>
      Object.freeze({
        id: question.id,
        text: question.text,
        correctChoiceId: question.correctChoiceId,
        choices: Object.freeze(
          question.choices.map((choice) => Object.freeze({ id: choice.id, text: choice.text })),
        ),
      }),
    ),
  );
  const first = privateQuestions[0]!; // Exactly ten validated questions.
  const started: StartedMatch = Object.freeze({
    id: match.id,
    hostPlayerId: match.hostPlayerId,
    participants: Object.freeze([...match.participants]),
    version,
    phase: 'QUESTION_OPEN',
    startedAt: openedAt,
    privateQuestions,
    currentQuestionIndex: 0,
    currentQuestion: Object.freeze({ ...first, openedAt, deadlineAt }),
  });
  return { status: 'accepted', changed: true, match: started };
}

/** now is an authoritative Clock reading at execution, not client time or a scheduling target. */
export function questionDeadline(
  match: MatchState,
  command: QuestionDeadlineCommand,
  now: number,
): MatchOutcome {
  if (match.phase !== 'QUESTION_OPEN') return reject(match, 'INVALID_MATCH_PHASE');
  if (command.matchId !== match.id) return reject(match, 'MATCH_ID_MISMATCH');
  if (command.questionId !== match.currentQuestion.id) return reject(match, 'QUESTION_NOT_CURRENT');
  if (!validTime(command.deadlineAt) || !validTime(now)) return reject(match, 'INVALID_TIMING');
  if (command.deadlineAt !== match.currentQuestion.deadlineAt)
    return reject(match, 'DEADLINE_MISMATCH');
  if (now < command.deadlineAt) return reject(match, 'DEADLINE_NOT_REACHED');
  const revealDeadlineAt = deadlineAfter(now, 5_000);
  if (revealDeadlineAt === undefined) return reject(match, 'INVALID_TIMING');
  return {
    status: 'accepted',
    changed: true,
    match: Object.freeze({
      ...match,
      phase: 'REVEAL',
      version: nextVersion(match.version),
      revealOpenedAt: now,
      revealDeadlineAt,
    }),
  };
}
