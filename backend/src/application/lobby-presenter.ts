import type { MatchState } from '../domain/match-engine.js';
import type { PlayerProfile } from './authenticate-player.js';

// Approved M1 defaults (LLD §4.6); these are descriptive, not configurable gameplay rules.
const rules = Object.freeze({
  questionCount: 10,
  answerWindowMs: 10_000,
  revealDurationMs: 5_000,
  allowAnswerChanges: true,
  maxAttempts: 3,
  earlyClose: false,
} as const);

export interface LobbySnapshot {
  readonly matchId: string;
  readonly version: number;
  readonly phase: 'WAITING';
  readonly state: {
    readonly hostPlayerId: string;
    readonly participants: readonly { readonly playerId: string; readonly displayName: string }[];
    readonly rules: typeof rules;
  };
}

export function presentLobby(match: MatchState, profiles: readonly PlayerProfile[]): LobbySnapshot {
  if (match.phase !== 'WAITING') throw new TypeError('Lobby projection requires WAITING');
  const names = new Map(profiles.map((profile) => [profile.id, profile.displayName]));
  if (profiles.length !== match.participants.length || names.size !== profiles.length)
    throw new Error('Incomplete lobby profiles');
  return Object.freeze({
    matchId: match.id,
    version: match.version,
    phase: 'WAITING',
    state: Object.freeze({
      hostPlayerId: match.hostPlayerId,
      participants: Object.freeze(
        match.participants.map((playerId) => {
          const displayName = names.get(playerId);
          if (displayName === undefined) throw new Error('Missing lobby profile');
          return Object.freeze({ playerId, displayName });
        }),
      ),
      rules,
    }),
  });
}
