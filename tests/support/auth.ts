import { LoginService } from '../../src/application/login.js';
import { MemorySessionStore } from '../../src/application/sessions.js';
import { SystemClock, NodeMatchScheduler } from '../../src/runtime/match-time.js';
import { readAuthPolicy } from '../../src/transport/auth-policy.js';
export function testAuth() {
  const clock = new SystemClock();
  const sessions = new MemorySessionStore(clock, new NodeMatchScheduler(clock));
  const policy = readAuthPolicy({
    AUTH_COOKIE_MODE: 'loopback',
    AUTH_PUBLIC_ORIGIN: 'http://localhost',
    AUTH_ORIGINS: 'http://localhost',
  });
  return {
    sessions,
    policy,
    login: new LoginService({ findCredentialByUsername: async () => null }, () => clock.now()),
  };
}
export const fixturePlayer = { id: 'cf80bf05-4821-4697-8ef7-5249fbad84cc', displayName: 'Fixture' };
