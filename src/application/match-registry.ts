import type { MatchId, MatchState } from '../domain/match-engine.js';

export type MatchLookup =
  | { readonly status: 'found'; readonly match: MatchState }
  | { readonly status: 'missing'; readonly code: 'MATCH_NOT_FOUND'; readonly matchId: MatchId };

/** Owned by one Coordinator. Only immutable Engine aggregates cross this boundary. */
export class MatchRegistry {
  #matches = new Map<MatchId, MatchState>();
  #closed = false;

  lookup(matchId: MatchId): MatchLookup {
    const match = this.#matches.get(matchId);
    return match
      ? { status: 'found', match }
      : { status: 'missing', code: 'MATCH_NOT_FOUND', matchId };
  }

  register(match: MatchState): void {
    if (this.#closed) throw new Error('Registry is closed');
    if (this.#matches.has(match.id)) throw new Error('Duplicate Match registration');
    if (!Object.isFrozen(match)) throw new TypeError('Registry requires immutable Engine state');
    this.#matches.set(match.id, match);
  }

  update(previous: MatchState, next: MatchState): void {
    if (this.#closed) throw new Error('Registry is closed');
    if (this.#matches.get(previous.id) !== previous || next.id !== previous.id) {
      throw new Error('Match update does not own the current aggregate');
    }
    if (!Object.isFrozen(next)) throw new TypeError('Registry requires immutable Engine state');
    this.#matches.set(next.id, next);
  }

  /** Runtime shutdown only: no per-Match release, TTL or eviction policy. */
  close(): void {
    this.#closed = true;
    this.#matches.clear();
  }
}
