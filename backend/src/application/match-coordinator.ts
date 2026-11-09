import * as engine from '../domain/match-engine.js';
import type {
  MatchId,
  MatchOutcome,
  MatchState,
  PlayerId,
  PrivateQuestion,
} from '../domain/match-engine.js';
import { MatchRegistry } from './match-registry.js';
import type { MatchLookup } from './match-registry.js';
import type { Clock, MatchScheduler } from './match-time.js';
import type { MatchCompletions } from './match-completions.js';

export type PlayerCommand =
  | { readonly type: 'join' | 'leave' | 'start-eligibility'; readonly matchId: MatchId }
  | {
      readonly type: 'start';
      readonly matchId: MatchId;
      readonly questions: readonly PrivateQuestion[];
    }
  | {
      readonly type: 'answer';
      readonly matchId: MatchId;
      readonly questionId: string;
      readonly choiceId: string;
    };

export type TimeoutCommand = {
  readonly type: 'question-deadline' | 'reveal-deadline';
  readonly matchId: MatchId;
  readonly questionId: string;
  readonly deadlineAt: number;
};

export interface CommandReceipt {
  readonly receivedAt: number;
  readonly receiptSequence: number;
  readonly outcome: MatchOutcome | Extract<MatchLookup, { status: 'missing' }>;
}

export interface TimerFailure {
  readonly matchId: MatchId;
  readonly error: unknown;
}

function identity(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new TypeError('Invalid trusted application identity');
}

/** Invoke synchronously; observe async failures without joining FIFO or shutdown. */
function runCallback(callback: () => unknown, failed?: () => unknown): void {
  const onFailure = () => {
    // A failed reporter is contained too, without reporting recursively.
    if (failed) runCallback(failed);
  };
  try {
    const result = callback();
    if (result !== undefined) void Promise.resolve(result).catch(onFailure);
  } catch {
    onFailure();
  }
}

/** One runtime owner: no transport, persistence, projections or gameplay rules. */
export class MatchCoordinator {
  #observer:
    | { notify: (change: { matchId: MatchId; version: number }) => void; failed: () => void }
    | undefined;
  #registry = new MatchRegistry();
  #queues = new Map<MatchId, Promise<void>>();
  #sequences = new Map<MatchId, number>();
  #outcomes = new Map<string, Promise<CommandReceipt>>();
  #creates = new Map<string, Promise<CommandReceipt>>();
  #pending = new Set<Promise<CommandReceipt>>();
  #timers = new Map<MatchId, { cancel: () => void }>();
  #failures: TimerFailure[] = [];
  #closed = false;
  #shutdown: Promise<void> | undefined;

  constructor(
    private readonly clock: Clock,
    private readonly scheduler: MatchScheduler,
    private readonly generateMatchId: () => MatchId,
    private readonly reportTimerFailure: (failure: TimerFailure) => void = () => {},
    private readonly completions?: MatchCompletions,
  ) {}

  /** One runtime delivery boundary; never awaited and never part of command success. */
  observeCommits(
    notify: (change: { matchId: MatchId; version: number }) => void,
    failed: () => void,
  ): () => void {
    const observer = { notify, failed };
    this.#observer = observer;
    return () => {
      if (this.#observer === observer) this.#observer = undefined;
    };
  }

  private committed(match: MatchState): void {
    const observer = this.#observer;
    if (!observer || this.#closed) return;
    runCallback(
      () => observer.notify({ matchId: match.id, version: match.version }),
      () => observer.failed(),
    );
  }

  lookup(matchId: MatchId): MatchLookup {
    identity(matchId);
    return this.#registry.lookup(matchId);
  }

  create(playerId: PlayerId, commandId: string): Promise<CommandReceipt> {
    this.assertOpen();
    identity(playerId);
    identity(commandId);
    const key = JSON.stringify([playerId, commandId]);
    const previous = this.#creates.get(key);
    if (previous) return previous;
    const receivedAt = this.now();
    const promise = Promise.resolve().then(() => {
      const outcome = engine.createMatch(playerId, this.generateMatchId);
      this.#registry.register(outcome.match);
      this.#sequences.set(outcome.match.id, 1);
      this.committed(outcome.match);
      return this.receipt(outcome, receivedAt, 1);
    });
    this.track(promise);
    return this.remember(this.#creates, key, promise);
  }

  dispatch(playerId: PlayerId, commandId: string, command: PlayerCommand): Promise<CommandReceipt> {
    this.assertOpen();
    identity(playerId);
    identity(commandId);
    identity(command.matchId);
    const key = JSON.stringify([command.matchId, playerId, commandId]);
    const previous = this.#outcomes.get(key);
    if (previous) return previous; // Original outcome, even if a caller reuses the ID with different data.
    if (!['join', 'leave', 'start-eligibility', 'start', 'answer'].includes(command.type)) {
      throw new TypeError('Unknown player command');
    }
    const receivedAt = this.now();
    const input = structuredClone(command);
    const promise = this.enqueue(input.matchId, receivedAt, (match) => {
      switch (input.type) {
        case 'join':
          return engine.joinMatch(match, playerId);
        case 'leave':
          return engine.leaveMatch(match, playerId);
        case 'start-eligibility':
          return engine.checkStartEligibility(match, playerId);
        case 'start':
          return engine.startMatch(match, playerId, input.questions, this.now());
        case 'answer':
          return engine.submitAnswer(match, playerId, input, receivedAt);
      }
    });
    return this.remember(this.#outcomes, key, promise);
  }

  /** Trusted system commands only; early timeout admission is invalid application input. */
  timeout(command: TimeoutCommand): Promise<CommandReceipt> {
    this.assertOpen();
    this.validateTimeout(command);
    const receivedAt = this.now();
    if (receivedAt < command.deadlineAt)
      throw new RangeError('Cannot admit a timeout before its deadline');
    return this.admitTimeout(Object.freeze({ ...command }), receivedAt);
  }

  /** Await the currently admitted per-Match work, useful to adapters during quiescence. */
  whenIdle(matchId: MatchId): Promise<void> {
    return this.#queues.get(matchId) ?? Promise.resolve();
  }

  /** Unexpected asynchronous scheduling/execution failures are observable, not domain no-ops. */
  takeTimerFailures(): readonly TimerFailure[] {
    return Object.freeze(this.#failures.splice(0));
  }

  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#closed = true;
    for (const matchId of this.#timers.keys()) this.cancelTimer(matchId);
    this.#shutdown = Promise.allSettled([...this.#pending]).then(() => {
      this.#registry.close();
      this.#queues.clear();
      this.#sequences.clear();
      this.#creates.clear();
      this.#outcomes.clear();
      this.#observer = undefined;
    });
    return this.#shutdown;
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error('Match runtime is closed');
  }

  private now(): number {
    const now = this.clock.now();
    if (!Number.isSafeInteger(now)) throw new TypeError('Invalid authoritative clock reading');
    return now;
  }

  private receipt(
    outcome: CommandReceipt['outcome'],
    receivedAt: number,
    receiptSequence: number,
  ): CommandReceipt {
    return Object.freeze({ outcome: Object.freeze(outcome), receivedAt, receiptSequence });
  }

  private remember(
    cache: Map<string, Promise<CommandReceipt>>,
    key: string,
    promise: Promise<CommandReceipt>,
  ): Promise<CommandReceipt> {
    cache.set(key, promise);
    // An exception establishes no command outcome. Allow a subsequent call to execute rather than poison the queue.
    void promise.catch(() => {
      if (cache.get(key) === promise) cache.delete(key);
    });
    return promise;
  }

  private track(promise: Promise<CommandReceipt>): void {
    this.#pending.add(promise);
    void promise.then(
      () => this.#pending.delete(promise),
      () => this.#pending.delete(promise),
    );
  }

  private enqueue(
    matchId: MatchId,
    receivedAt: number,
    execute: (match: MatchState) => MatchOutcome,
  ): Promise<CommandReceipt> {
    const sequence = (this.#sequences.get(matchId) ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error('Receipt sequence exhausted');
    this.#sequences.set(matchId, sequence);
    // No asynchronous yield between timestamp capture, sequence assignment and queue placement.
    const promise = (this.#queues.get(matchId) ?? Promise.resolve()).then(() => {
      const lookup = this.#registry.lookup(matchId);
      if (lookup.status === 'missing') return this.receipt(lookup, receivedAt, sequence);
      const outcome = execute(lookup.match);
      if (outcome.status === 'accepted' && outcome.changed) {
        this.#registry.update(lookup.match, outcome.match);
        // Capture survives Gateway closure and closed ingress while admitted FIFO work drains.
        if (outcome.match.phase === 'FINISHED') this.completions?.capture(outcome.match.result);
        this.refreshTimer(lookup.match, outcome.match); // Commit precedes scheduling and receipt publication.
        this.committed(outcome.match);
      }
      return this.receipt(outcome, receivedAt, sequence);
    });
    const tail = promise.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(matchId, tail);
    void tail.then(() => {
      if (this.#queues.get(matchId) === tail) this.#queues.delete(matchId);
    });
    this.track(promise);
    return promise;
  }

  private validateTimeout(command: TimeoutCommand): void {
    identity(command.matchId);
    identity(command.questionId);
    if (
      !['question-deadline', 'reveal-deadline'].includes(command.type) ||
      !Number.isSafeInteger(command.deadlineAt)
    ) {
      throw new TypeError('Invalid trusted timeout command');
    }
  }

  private admitTimeout(command: TimeoutCommand, receivedAt: number): Promise<CommandReceipt> {
    return this.enqueue(command.matchId, receivedAt, (match) =>
      command.type === 'question-deadline'
        ? engine.questionDeadline(match, command, this.now())
        : engine.revealDeadline(match, command, this.now()),
    );
  }

  private failure(matchId: MatchId, error: unknown): void {
    const failure = Object.freeze({ matchId, error });
    this.#failures.push(failure);
    runCallback(() => this.reportTimerFailure(failure));
  }

  private cancelTimer(matchId: MatchId): void {
    const timer = this.#timers.get(matchId);
    this.#timers.delete(matchId);
    if (timer) {
      try {
        timer.cancel();
      } catch (error) {
        this.failure(matchId, error);
      }
    }
  }

  private refreshTimer(previous: MatchState, next: MatchState): void {
    if (previous.phase === next.phase) return; // Answer/membership changes do not replace an unchanged deadline.
    this.cancelTimer(next.id);
    if (this.#closed || next.phase === 'WAITING' || next.phase === 'FINISHED') return;
    const command: TimeoutCommand = Object.freeze({
      type: next.phase === 'QUESTION_OPEN' ? 'question-deadline' : 'reveal-deadline',
      matchId: next.id,
      questionId: next.currentQuestion.id,
      deadlineAt:
        next.phase === 'QUESTION_OPEN' ? next.currentQuestion.deadlineAt : next.revealDeadlineAt,
    });
    this.arm(command);
  }

  private arm(command: TimeoutCommand): void {
    const timer = { cancel: () => {} };
    try {
      timer.cancel = this.scheduler.schedule(command.deadlineAt, (failure?: unknown) => {
        if (this.#closed) return;
        try {
          if (failure !== undefined) throw failure;
          const receivedAt = this.now();
          if (receivedAt < command.deadlineAt) {
            if (this.#timers.get(command.matchId) === timer) {
              this.cancelTimer(command.matchId);
              this.arm(command);
            }
            return;
          }
          void this.admitTimeout(command, receivedAt).catch((error: unknown) =>
            this.failure(command.matchId, error),
          );
        } catch (error) {
          this.failure(command.matchId, error);
        }
      });
      this.#timers.set(command.matchId, timer);
    } catch (error) {
      this.failure(command.matchId, error);
    }
  }
}
