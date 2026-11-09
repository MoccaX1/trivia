import { createHash, randomBytes } from 'node:crypto';
import type { PlayerProfile } from './authenticate-player.js';
import type { Clock, MatchScheduler } from './match-time.js';

export const idleMs = 30 * 60_000;
export const absoluteMs = 12 * 60 * 60_000;
export interface SessionStore {
  create(player: PlayerProfile): Promise<string>;
  resolve(token: string): Promise<PlayerProfile | null>;
  // Non-refreshing authorization and delivery share one synchronous boundary.
  inspect<T>(token: string, action: (player: PlayerProfile) => T): Promise<{ value: T } | null>;
  revoke(token: string): Promise<void>;
  // The implementation invokes action immediately after its final authorization
  // check, without yielding. Future Gateway admission belongs inside this callback.
  act<T>(token: string, action: (player: PlayerProfile) => T): Promise<{ value: T } | null>;
  watch(token: string, invalidated: () => void): Promise<(() => void) | null>;
  close(): Promise<void>;
}
interface Session {
  player: PlayerProfile;
  idle: number;
  absolute: number;
  cancel: () => void;
  listeners: Set<() => void>;
}
function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** One expiry timer per live session: O(1) cleanup, no whole-store sweeps. */
export class MemorySessionStore implements SessionStore {
  #sessions = new Map<string, Session>();
  #closed = false;
  constructor(
    private clock: Clock,
    private scheduler: MatchScheduler,
    private reportFailure: () => void = () => {},
  ) {}

  async create(player: PlayerProfile): Promise<string> {
    if (this.#closed) throw new Error('Session store closed');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(player.id))
      throw new TypeError('Invalid trusted Player UUID');
    const token = randomBytes(32).toString('base64url');
    const key = digest(token);
    const now = this.clock.now();
    const session: Session = {
      player: Object.freeze({ id: player.id, displayName: player.displayName }),
      idle: now + idleMs,
      absolute: now + absoluteMs,
      cancel: () => {},
      listeners: new Set(),
    };
    this.#sessions.set(key, session);
    try {
      this.arm(key, session);
    } catch (error) {
      this.#sessions.delete(key);
      throw error;
    }
    return token;
  }
  private find(token: string): Session | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const key = digest(token);
    const session = this.#sessions.get(key);
    if (session && this.clock.now() >= Math.min(session.idle, session.absolute)) {
      this.remove(key, session);
      return;
    }
    return session;
  }
  private remove(key: string, session: Session): void {
    this.#sessions.delete(key);
    session.cancel();
    for (const listener of session.listeners) listener();
    session.listeners.clear();
  }
  private arm(key: string, session: Session): void {
    session.cancel();
    session.cancel = this.scheduler.schedule(
      Math.min(session.idle, session.absolute),
      (failure) => {
        if (this.#sessions.get(key) !== session) return;
        try {
          if (failure !== undefined) {
            this.reportFailure();
            this.remove(key, session);
            return;
          }
          if (this.clock.now() >= Math.min(session.idle, session.absolute))
            this.remove(key, session);
          else this.arm(key, session);
        } catch {
          this.reportFailure();
          this.remove(key, session);
        }
      },
    );
  }
  async resolve(token: string): Promise<PlayerProfile | null> {
    return this.find(token)?.player ?? null;
  }
  async inspect<T>(
    token: string,
    action: (player: PlayerProfile) => T,
  ): Promise<{ value: T } | null> {
    const session = this.find(token);
    return session ? { value: action(session.player) } : null;
  }
  async act<T>(token: string, action: (player: PlayerProfile) => T): Promise<{ value: T } | null> {
    const session = this.find(token);
    if (!session) return null;
    session.idle = Math.min(this.clock.now() + idleMs, session.absolute);
    this.arm(digest(token), session);
    return { value: action(session.player) };
  }
  async revoke(token: string): Promise<void> {
    const session = this.find(token);
    if (session) this.remove(digest(token), session);
  }
  async watch(token: string, invalidated: () => void): Promise<(() => void) | null> {
    const session = this.find(token);
    if (!session) return null;
    session.listeners.add(invalidated);
    return () => {
      session.listeners.delete(invalidated);
    };
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const [key, session] of this.#sessions) this.remove(key, session);
  }
}
