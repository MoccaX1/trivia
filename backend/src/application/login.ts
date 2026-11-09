import { authenticatePlayer } from './authenticate-player.js';
import type { PlayerCredentials, AuthenticationResult } from './authenticate-player.js';
import { canonicalUsername } from './player-identity.js';
import { verifyPassword } from './password.js';

const windowMs = 15 * 60_000;
// Exact sliding windows with capped key counts and periodic stale-entry cleanup.
// Each key holds at most its configured attempt limit.
export class LoginService {
  #ips = new Map<string, number[]>();
  #names = new Map<string, number[]>();
  #active = 0;
  #pendingNames = new Map<string, number>();
  #closed = false;
  #cleanup: ReturnType<typeof setInterval>;
  constructor(
    private repository: Pick<PlayerCredentials, 'findCredentialByUsername'>,
    private now: () => number,
    private verify = verifyPassword,
  ) {
    this.#cleanup = setInterval(() => this.prune(), 60_000);
    this.#cleanup.unref();
  }
  private times(map: Map<string, number[]>, key: string): number[] {
    const values = (map.get(key) ?? []).filter((time) => time > this.now() - windowMs);
    if (values.length) map.set(key, values);
    else map.delete(key);
    return values;
  }
  private prune(): void {
    for (const key of this.#ips.keys()) this.times(this.#ips, key);
    for (const key of this.#names.keys()) this.times(this.#names, key);
  }
  admitIp(ip: string): { status: 'rate_limited' | 'busy' } | null {
    if (this.#closed || (!this.#ips.has(ip) && this.#ips.size >= 10_000)) return { status: 'busy' };
    const ips = this.times(this.#ips, ip);
    if (ips.length >= 60) return { status: 'rate_limited' };
    ips.push(this.now());
    this.#ips.set(ip, ips);
    return null;
  }
  async login(
    ip: string,
    username: string,
    password: string,
    ipAlreadyCounted = false,
  ): Promise<AuthenticationResult | { status: 'rate_limited' | 'busy' }> {
    if (this.#closed) return { status: 'busy' };
    username = canonicalUsername(username);
    if (
      (!this.#ips.has(ip) && this.#ips.size >= 10_000) ||
      (!this.#names.has(username) && this.#names.size + this.#pendingNames.size >= 10_000)
    )
      return { status: 'busy' };
    const admission = ipAlreadyCounted ? null : this.admitIp(ip);
    if (admission) return admission;
    if (this.times(this.#names, username).length >= 10) return { status: 'rate_limited' };
    // Reserve before lookup: at most four concurrent lookups/verifications, no queue.
    const pending = this.#pendingNames.get(username) ?? 0;
    if (this.#active >= 4 || this.times(this.#names, username).length + pending >= 10)
      return { status: 'busy' };
    this.#active++;
    this.#pendingNames.set(username, pending + 1);
    try {
      const result = await authenticatePlayer(this.repository, username, password, this.verify);
      if (!this.#closed && result.status === 'invalid_credentials') {
        const names = this.times(this.#names, username);
        if (names.length < 10) names.push(this.now());
        this.#names.set(username, names);
      }
      return result;
    } finally {
      this.#active--;
      const remaining = this.#pendingNames.get(username)! - 1;
      if (remaining) this.#pendingNames.set(username, remaining);
      else this.#pendingNames.delete(username);
    }
  }
  close(): void {
    this.#closed = true;
    clearInterval(this.#cleanup);
    this.#ips.clear();
    this.#names.clear();
  }
}
