/** Integer milliseconds in the same authoritative clock domain used by the Engine. */
export interface Clock {
  now(): number;
}

export interface MatchScheduler {
  /** Callback must not be invoked inline. Cancellation may race with a due callback. */
  schedule(deadlineAt: number, callback: (error?: unknown) => void): () => void;
}
