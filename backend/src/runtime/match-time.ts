import { performance } from 'node:perf_hooks';
import type { Clock, MatchScheduler } from '../application/match-time.js';

/** Epoch-based milliseconds advancing with monotonic elapsed time, independent of wall-clock adjustments. */
export class SystemClock implements Clock {
  #epoch = Date.now();
  #origin = performance.now();

  now(): number {
    return this.#epoch + Math.floor(performance.now() - this.#origin);
  }
}

export class NodeMatchScheduler implements MatchScheduler {
  constructor(private readonly clock: Clock) {}

  schedule(deadlineAt: number, callback: (error?: unknown) => void): () => void {
    if (!Number.isSafeInteger(deadlineAt)) throw new TypeError('Invalid deadline');
    let cancelled = false;
    let handle: ReturnType<typeof setTimeout>;
    const arm = () => {
      const remaining = deadlineAt - this.clock.now();
      handle = setTimeout(
        () => {
          if (cancelled) return;
          // Early wakeups and Node's maximum timeout delay cannot admit an early deadline command.
          let early: boolean;
          try {
            early = this.clock.now() < deadlineAt;
            if (early) arm();
          } catch (error) {
            callback(error);
            return;
          }
          if (!early) callback();
        },
        Math.min(2_147_483_647, Math.max(0, remaining)),
      );
    };
    arm();
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }
}
