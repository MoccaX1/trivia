import type { MatchResult } from '../domain/match-engine.js';
import { CompletionError, durableMatch } from './completed-match.js';
import type { CompletedMatchWriter } from './completed-match.js';

export type CompletionOutcome = Readonly<{
  matchId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'unconfirmed';
  attempt: number;
  code?: CompletionError['code'] | 'COMPLETION_DRAIN_TIMEOUT' | 'COMPLETION_INTERNAL_FAILURE';
}>;
interface Entry {
  readonly result: MatchResult;
  canonical: string;
  outcome: CompletionOutcome;
  active: boolean;
  promise?: Promise<CompletionOutcome>;
}

/** Owns immutable completions independently of Gateway subscriptions and Coordinator queues. */
export class MatchCompletions {
  #entries = new Map<string, Entry>();
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(
    private readonly repository: CompletedMatchWriter,
    private readonly report: (outcome: CompletionOutcome) => void = () => {},
  ) {}

  capture(result: MatchResult): Promise<CompletionOutcome> {
    const key = result.matchId.toLowerCase();
    const previous = this.#entries.get(key);
    if (previous) {
      if (previous.result === result) return previous.promise!;
      try {
        if (previous.canonical !== JSON.stringify(durableMatch(result))) {
          const outcome = Object.freeze({
            matchId: result.matchId,
            status: 'failed' as const,
            attempt: previous.outcome.attempt,
            code: 'COMPLETION_CONFLICT' as const,
          });
          this.diagnostic(outcome);
          return Promise.resolve(outcome);
        }
      } catch {
        const outcome = Object.freeze({
          matchId: result.matchId,
          status: 'failed' as const,
          attempt: previous.outcome.attempt,
          code: 'INVALID_COMPLETION' as const,
        });
        this.diagnostic(outcome);
        return Promise.resolve(outcome);
      }
      return previous.promise!; // Duplicate observations do not implicitly retry failures.
    }
    if (this.#closed) throw new Error('Completion intake is closed');
    const entry: Entry = {
      result,
      canonical: '',
      active: false,
      outcome: Object.freeze({ matchId: result.matchId, status: 'pending', attempt: 0 }),
    };
    // Ownership is recorded synchronously before validation or any asynchronous SQL operation.
    this.#entries.set(key, entry);
    try {
      entry.canonical = JSON.stringify(durableMatch(result));
    } catch {
      entry.outcome = Object.freeze({
        matchId: result.matchId,
        status: 'failed',
        attempt: 0,
        code: 'INVALID_COMPLETION',
      });
      entry.promise = Promise.resolve(entry.outcome);
      this.diagnostic(entry.outcome);
      return entry.promise;
    }
    return this.start(entry);
  }

  outcome(matchId: string): CompletionOutcome | undefined {
    return this.#entries.get(matchId.toLowerCase())?.outcome;
  }

  retry(matchId: string): Promise<CompletionOutcome> {
    if (this.#closed) throw new Error('Completion intake is closed');
    const entry = this.#entries.get(matchId.toLowerCase());
    if (!entry) throw new TypeError('Unknown completion');
    if (
      entry.active ||
      entry.outcome.status === 'succeeded' ||
      entry.outcome.code === 'COMPLETION_CONFLICT' ||
      entry.outcome.code === 'INVALID_COMPLETION'
    )
      return entry.promise!;
    return this.start(entry);
  }

  private start(entry: Entry): Promise<CompletionOutcome> {
    entry.active = true;
    entry.outcome = Object.freeze({
      matchId: entry.result.matchId,
      status: 'pending',
      attempt: entry.outcome.attempt + 1,
    });
    // SQL begins in a later microtask, never inside Coordinator execution.
    entry.promise = Promise.resolve()
      .then(() => this.repository.save(entry.result))
      .then(
        () => {
          entry.active = false;
          return this.finish(entry, 'succeeded');
        },
        (error: unknown) => {
          entry.active = false;
          return this.finish(
            entry,
            error instanceof CompletionError && error.code === 'COMPLETION_UNCONFIRMED'
              ? 'unconfirmed'
              : 'failed',
            error instanceof CompletionError ? error.code : 'COMPLETION_INTERNAL_FAILURE',
          );
        },
      );
    return entry.promise;
  }

  private finish(
    entry: Entry,
    status: CompletionOutcome['status'],
    code?: CompletionOutcome['code'],
  ): CompletionOutcome {
    const outcome: CompletionOutcome = Object.freeze({
      matchId: entry.result.matchId,
      status,
      attempt: entry.outcome.attempt,
      ...(code ? { code } : {}),
    });
    entry.outcome = outcome;
    this.diagnostic(outcome);
    return outcome;
  }

  private diagnostic(outcome: CompletionOutcome): void {
    try {
      const result = this.report(outcome);
      if (result !== undefined) void Promise.resolve(result).catch(() => {});
    } catch {
      /* A reporting failure cannot invalidate an authoritative completion. */
    }
  }

  /** Called by the existing process shutdown watchdog, not a separate timeout/retry budget. */
  reportPending(): void {
    for (const entry of this.#entries.values())
      if (entry.outcome.status === 'pending')
        this.finish(entry, 'unconfirmed', 'COMPLETION_DRAIN_TIMEOUT');
  }

  /** Production's existing 10-second watchdog bounds this drain and pool cleanup together. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = Promise.all([...this.#entries.values()].map((entry) => entry.promise)).then(
      () => {
        if ([...this.#entries.values()].some((entry) => entry.outcome.status !== 'succeeded'))
          throw new Error('COMPLETION_DRAIN_FAILED');
      },
    );
    return this.#closing;
  }
}
