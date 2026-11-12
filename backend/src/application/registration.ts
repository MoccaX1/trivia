import { provisionPlayer } from './authenticate-player.js';
import type { PlayerCredentials, PlayerProfile } from './authenticate-player.js';
import { canonicalUsername, validateDisplayName } from './player-identity.js';

export const registrationLimits = {
  concurrent: 2,
  perIp: 20,
  ipWindowMs: 15 * 60_000,
  global: 100,
  globalWindowMs: 60 * 60_000,
  ipKeys: 1_000,
} as const;
export type RegistrationAdmission =
  { status: 'rate_limited'; retryAfter: number } | { status: 'busy'; retryAfter: number };
export interface RegistrationInput {
  username: string;
  displayName: string;
  password: string;
}
export function registrationInput(value: unknown): RegistrationInput | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !('username' in value) ||
    !('displayName' in value) ||
    !('password' in value) ||
    typeof value.username !== 'string' ||
    typeof value.displayName !== 'string' ||
    typeof value.password !== 'string'
  )
    return;
  try {
    const username = canonicalUsername(value.username);
    validateDisplayName(value.displayName);
    if ([...value.password].length < 15 || Buffer.byteLength(value.password) > 1024) return;
    return { username, displayName: value.displayName, password: value.password };
  } catch {
    return;
  }
}

/** Public admission wraps the trusted provisioning primitive; it never creates a session. */
export class RegistrationService {
  #ips = new Map<string, number[]>();
  #global: number[] = [];
  #jobs = new Set<Promise<PlayerProfile>>();
  #closed = false;
  #cleanup: ReturnType<typeof setInterval>;
  constructor(
    private repository: Pick<PlayerCredentials, 'createPlayerWithCredential'>,
    private now: () => number,
    private create = provisionPlayer,
  ) {
    this.#cleanup = setInterval(() => this.prune(), 60_000);
    this.#cleanup.unref();
  }
  private prune(): void {
    const now = this.now();
    for (const [ip, times] of this.#ips) {
      const remaining = times.filter((time) => time > now - registrationLimits.ipWindowMs);
      if (remaining.length) this.#ips.set(ip, remaining);
      else this.#ips.delete(ip);
    }
    this.#global = this.#global.filter((time) => time > now - registrationLimits.globalWindowMs);
  }
  /** Transport calls once after Origin/TLS checks, before parsing, including malformed bodies. */
  admitIp(ip: string): RegistrationAdmission | undefined {
    if (this.#closed) return { status: 'busy', retryAfter: 1 };
    this.prune();
    const now = this.now();
    const times = this.#ips.get(ip) ?? [];
    const deadlines: number[] = [];
    if (times.length >= registrationLimits.perIp)
      deadlines.push(times[0]! + registrationLimits.ipWindowMs);
    if (this.#global.length >= registrationLimits.global)
      deadlines.push(this.#global[0]! + registrationLimits.globalWindowMs);
    if (deadlines.length)
      return {
        status: 'rate_limited',
        retryAfter: Math.max(1, Math.ceil((Math.max(...deadlines) - now) / 1000)),
      };
    if (!this.#ips.has(ip) && this.#ips.size >= registrationLimits.ipKeys)
      return { status: 'busy', retryAfter: 1 };
    times.push(now);
    this.#ips.set(ip, times);
    this.#global.push(now);
    return;
  }
  async register(
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: 'created'; player: PlayerProfile } | { status: 'invalid' | 'busy' }> {
    const input = registrationInput(body);
    if (!input) return { status: 'invalid' };
    if (this.#closed || signal?.aborted || this.#jobs.size >= registrationLimits.concurrent)
      return { status: 'busy' };
    const job = Promise.resolve().then(() => {
      if (signal?.aborted) throw new Error('REGISTRATION_ABORTED');
      return this.create(this.repository, input.username, input.displayName, input.password);
    });
    this.#jobs.add(job);
    try {
      // Argon2 cannot be cancelled. Retain the slot until hashing/COMMIT settles,
      // even after disconnect; releasing early would permit unbounded native work.
      return { status: 'created', player: await job };
    } finally {
      this.#jobs.delete(job);
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#cleanup);
    this.#ips.clear();
    this.#global = [];
    await Promise.allSettled(this.#jobs);
  }
}
