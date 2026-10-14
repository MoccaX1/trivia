export type PlayerId = string;
export type MatchId = string;

export interface WaitingMatch {
  readonly id: MatchId;
  readonly hostPlayerId: PlayerId;
  readonly phase: 'WAITING';
  readonly participants: readonly PlayerId[];
  readonly version: number;
}

type RejectionCode =
  | 'INVALID_MATCH_PHASE'
  | 'MATCH_FINISHED'
  | 'ALREADY_MATCH_PARTICIPANT'
  | 'MATCH_FULL'
  | 'NOT_MATCH_PARTICIPANT'
  | 'NOT_HOST'
  | 'INSUFFICIENT_PARTICIPANTS';

export type LobbyOutcome =
  | { readonly status: 'accepted'; readonly match: WaitingMatch; readonly changed: boolean }
  | { readonly status: 'rejected'; readonly match: WaitingMatch; readonly code: RejectionCode }
  | {
      readonly status: 'unsupported';
      readonly match: WaitingMatch;
      readonly reason: 'HOST_DEPARTURE_DEFERRED';
    };

function assertIdentity(identity: string): void {
  if (typeof identity !== 'string' || identity.trim().length === 0) {
    throw new TypeError('Expected a nonblank server-resolved identity');
  }
}

function freezeMatch(match: WaitingMatch): WaitingMatch {
  return Object.freeze({ ...match, participants: Object.freeze([...match.participants]) });
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

function reject(match: WaitingMatch, code: RejectionCode): LobbyOutcome {
  return { status: 'rejected', match, code };
}

function validateWaiting(match: WaitingMatch, playerId: PlayerId): LobbyOutcome | undefined {
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

export function joinMatch(match: WaitingMatch, playerId: PlayerId): LobbyOutcome {
  const invalid = validateWaiting(match, playerId);
  if (invalid) return invalid;
  if (match.participants.includes(playerId)) return reject(match, 'ALREADY_MATCH_PARTICIPANT');
  if (match.participants.length === 10) return reject(match, 'MATCH_FULL');
  return {
    status: 'accepted',
    changed: true,
    match: freezeMatch({
      ...match,
      participants: [...match.participants, playerId],
      version: match.version + 1,
    }),
  };
}

export function leaveMatch(match: WaitingMatch, playerId: PlayerId): LobbyOutcome {
  const invalid = validateWaiting(match, playerId);
  if (invalid) return invalid;
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
      version: match.version + 1,
    }),
  };
}

/** Eligibility only: this does not execute Start or open a question. */
export function checkStartEligibility(match: WaitingMatch, playerId: PlayerId): LobbyOutcome {
  const invalid = validateWaiting(match, playerId);
  if (invalid) return invalid;
  if (!match.participants.includes(playerId)) return reject(match, 'NOT_MATCH_PARTICIPANT');
  if (playerId !== match.hostPlayerId) return reject(match, 'NOT_HOST');
  if (match.participants.length < 2) return reject(match, 'INSUFFICIENT_PARTICIPANTS');
  return { status: 'accepted', changed: false, match };
}
