import assert from 'node:assert/strict';
import test from 'node:test';
import { io } from 'socket.io-client';
import { createServer } from '../src/transport/server.js';
import { readAuthPolicy, sessionCookie } from '../src/transport/auth-policy.js';
import { LoginService } from '../src/application/login.js';
import { MemorySessionStore, idleMs } from '../src/application/sessions.js';
import { fixturePlayer, testAuth } from './support/auth.js';

const origin = 'http://localhost';
function setup(t: { after(callback: () => Promise<void>): void }) {
  let now = 0,
    checks = 0,
    outage = false;
  const auth = testAuth();
  auth.login.close();
  void auth.sessions.close();
  const tasks = new Set<{ at: number; cb: (error?: unknown) => void }>();
  auth.sessions = new MemorySessionStore(
    { now: () => now },
    {
      schedule(at, cb) {
        const task = { at, cb };
        tasks.add(task);
        return () => {
          tasks.delete(task);
        };
      },
    },
  );
  auth.login = new LoginService(
    {
      findCredentialByUsername: async (name) => {
        if (outage) throw new Error('DATABASE_SECRET');
        return name === 'alice' ? { player: fixturePlayer, passwordHash: 'known' } : null;
      },
    },
    () => now,
    async (hash, password) => {
      checks++;
      return hash === 'known' && password === 'páss 👩‍💻';
    },
  );
  const server = createServer({ auth });
  t.after(() => server.close());
  const headers = { origin, 'content-type': 'application/json' };
  return {
    auth,
    server,
    headers,
    checks: () => checks,
    outage: () => {
      outage = true;
    },
    advance: (time: number) => {
      now = time;
      for (const task of [...tasks])
        if (task.at <= now) {
          tasks.delete(task);
          task.cb();
        }
    },
    login: (username = 'ALICE', password = 'páss 👩‍💻') =>
      server.inject({
        method: 'POST',
        url: '/auth/login',
        headers,
        payload: { username, password },
      }),
  };
}
test('HTTP login returns public profile, rotates tokens and isolates logout; profile does not refresh idle', async (t) => {
  const f = setup(t);
  const first = await f.login();
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { player: fixturePlayer });
  const cookie = first.headers['set-cookie'] as string;
  assert.match(cookie, /^trivia_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax$/);
  const second = await f.login();
  assert.notEqual(second.headers['set-cookie'], cookie);
  const headers = { ...f.headers, cookie };
  assert.equal(
    (await f.server.inject({ url: '/auth/profile?playerId=spoof', headers: f.headers })).statusCode,
    401,
  );
  f.advance(idleMs - 1);
  assert.equal((await f.server.inject({ url: '/auth/profile', headers })).statusCode, 200);
  const logout = await f.server.inject({
    method: 'POST',
    url: '/auth/logout',
    headers,
    payload: {},
  });
  assert.equal(logout.statusCode, 204);
  assert.equal(
    (await f.server.inject({ method: 'POST', url: '/auth/logout', headers, payload: {} }))
      .statusCode,
    401,
  );
  assert.match(logout.headers['set-cookie'] as string, /Max-Age=0/);
  assert.equal((await f.server.inject({ url: '/auth/profile', headers })).statusCode, 401);
  assert.equal(
    (
      await f.server.inject({
        url: '/auth/profile',
        headers: { ...headers, cookie: second.headers['set-cookie'] as string },
      })
    ).statusCode,
    200,
  );
  f.advance(idleMs);
  assert.equal(
    (
      await f.server.inject({
        url: '/auth/profile',
        headers: { ...headers, cookie: second.headers['set-cookie'] as string },
      })
    ).statusCode,
    401,
  );
});
test('unknown username and incorrect password are equivalent, use verification, and outages are 503', async (t) => {
  const f = setup(t);
  const wrong = await f.login('alice', 'SECRET_WRONG'),
    unknown = await f.login('missing', 'SECRET_WRONG');
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(wrong.json(), { code: 'INVALID_CREDENTIALS' });
  assert.equal(wrong.body, unknown.body);
  assert.equal(f.checks(), 2);
  f.outage();
  const result = await f.login();
  assert.equal(result.statusCode, 503);
  assert.doesNotMatch(result.body, /SECRET|hash|password/);
});
test('invalid shape, username, Unicode password byte bounds and oversized JSON bypass Argon2', async (t) => {
  const f = setup(t);
  for (const payload of [
    { username: 'alice', password: 'p', playerId: 'spoof' },
    { username: ' alice', password: 'p' },
    { username: 'é', password: 'p' },
    { username: 'alice', password: '😀'.repeat(257) },
    { username: 'alice', password: '' },
    { username: 'alice', password: 7 },
    ['alice', 'p'],
  ]) {
    assert.equal(
      (await f.server.inject({ method: 'POST', url: '/auth/login', headers: f.headers, payload }))
        .statusCode,
      400,
    );
  }
  assert.equal(
    (
      await f.server.inject({
        method: 'POST',
        url: '/auth/login',
        headers: f.headers,
        payload: JSON.stringify({ username: 'alice', password: 'p' }) + ' '.repeat(4096),
      })
    ).statusCode,
    413,
  );
  const malformed = await f.server.inject({
    method: 'POST',
    url: '/auth/login',
    headers: f.headers,
    payload: '{"password":"PRIVATE_SECRET" bad',
  });
  assert.equal(malformed.statusCode, 400);
  assert.doesNotMatch(malformed.body, /PRIVATE_SECRET/);
  assert.equal(f.checks(), 0);
  assert.equal((await f.login('alice', '😀'.repeat(256))).statusCode, 401);
  assert.equal(f.checks(), 1);
});
test('exact Origin, JSON and credentialed preflight are enforced without wildcard reflection', async (t) => {
  const f = setup(t);
  for (const bad of ['', 'null', 'http://evil.localhost', 'http://localhost:4444'])
    assert.equal(
      (
        await f.server.inject({
          method: 'POST',
          url: '/auth/login',
          headers: { origin: bad },
          payload: {},
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (
      await f.server.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { origin, 'content-type': 'text/plain' },
        payload: '',
      })
    ).statusCode,
    415,
  );
  const result = await f.server.inject({
    method: 'OPTIONS',
    url: '/auth/login',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(result.statusCode, 204);
  assert.equal(result.headers['access-control-allow-origin'], origin);
  assert.equal(result.headers['access-control-allow-credentials'], 'true');
});
test('direct clients cannot spoof IP with X-Forwarded-For; approved trusted proxy uses Fastify IP resolution', async (t) => {
  const f = setup(t);
  for (let n = 0; n < 60; n++)
    await f.server.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { ...f.headers, 'x-forwarded-for': `10.0.0.${n}` },
      payload: { username: 'alice', password: 'páss 👩‍💻' },
    });
  assert.equal((await f.login()).statusCode, 429);
  const auth = testAuth();
  auth.policy.trustProxy = ['127.0.0.1'];
  const seen: string[] = [];
  auth.login.login = async (ip) => {
    seen.push(ip);
    return { status: 'invalid_credentials' };
  };
  const server = createServer({ auth });
  t.after(() => server.close());
  await server.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { ...f.headers, 'x-forwarded-for': '10.0.0.8' },
    payload: { username: 'alice', password: 'p' },
  });
  assert.deepEqual(seen, ['10.0.0.8']);
});
test('secure policy fails closed, recognizes PSL/private sites, and emits __Host cookie', () => {
  assert.throws(() =>
    readAuthPolicy({
      AUTH_COOKIE_MODE: 'loopback',
      AUTH_PUBLIC_ORIGIN: 'http://127.0.0.1',
      AUTH_ORIGINS: 'http://localhost',
    }),
  );
  const policy = readAuthPolicy({
    AUTH_COOKIE_MODE: 'secure',
    AUTH_PUBLIC_ORIGIN: 'https://api.example.com',
    AUTH_ORIGINS: 'https://app.example.com:444',
  });
  assert.equal(
    sessionCookie(policy, 'token'),
    '__Host-trivia_session=token; Path=/; HttpOnly; SameSite=Lax; Secure',
  );
  for (const env of [
    {},
    { AUTH_COOKIE_MODE: 'loopback', NODE_ENV: 'production' },
    {
      AUTH_COOKIE_MODE: 'loopback',
      AUTH_PUBLIC_ORIGIN: 'http://192.168.1.1',
      AUTH_ORIGINS: origin,
    },
    {
      AUTH_COOKIE_MODE: 'secure',
      AUTH_PUBLIC_ORIGIN: 'https://a.github.io',
      AUTH_ORIGINS: 'https://b.github.io',
    },
    {
      AUTH_COOKIE_MODE: 'secure',
      AUTH_PUBLIC_ORIGIN: 'https://api.example.com',
      AUTH_ORIGINS: 'http://app.example.com',
    },
  ])
    assert.throws(() => readAuthPolicy(env));
});
for (const transport of ['polling', 'websocket']) {
  test(`${transport}: cookie authentication, explicit Origin, spoof resistance and session-isolated expiry/logout`, async (t) => {
    const f = setup(t);
    const address = await f.server.listen({ host: '127.0.0.1', port: 0 });
    async function connect(cookie: string, suppliedOrigin = origin) {
      const socket = io(address, {
        transports: [transport],
        extraHeaders: { Origin: suppliedOrigin, Cookie: cookie },
        auth: { playerId: 'spoof', displayName: 'spoof' },
        reconnection: false,
        autoConnect: false,
        timeout: 1000,
      });
      t.after(() => {
        socket.disconnect();
      });
      const connected = new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      socket.connect();
      await connected;
      return socket;
    }
    await assert.rejects(connect(''));
    const login = await f.login();
    const cookie = login.headers['set-cookie'] as string;
    await assert.rejects(connect(cookie, 'http://evil.test'));
    await assert.rejects(connect(cookie, ''));
    const first = await connect(cookie),
      repeat = await connect(cookie);
    // Resolve identity independently of hostile handshake metadata.
    assert.deepEqual(
      await f.auth.sessions.resolve(cookie.split(';')[0]!.split('=')[1]!),
      fixturePlayer,
    );
    f.advance(100);
    const secondLogin = await f.login();
    const second = await connect(secondLogin.headers['set-cookie'] as string);
    const firstGone = new Promise((resolve) => first.once('disconnect', resolve)),
      repeatGone = new Promise((resolve) => repeat.once('disconnect', resolve));
    await f.server.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { ...f.headers, cookie },
      payload: {},
    });
    await Promise.all([firstGone, repeatGone]);
    assert.equal(second.connected, true);
    await assert.rejects(connect(cookie));
    const expired = new Promise((resolve) => second.once('disconnect', resolve));
    f.advance(idleMs + 100);
    await expired;
    await assert.rejects(connect(secondLogin.headers['set-cookie'] as string));
  });
}

test('HTTPS cannot be forged from an untrusted peer and secure cookies work via configured TLS proxy', async (t) => {
  const auth = testAuth();
  auth.policy = readAuthPolicy({
    AUTH_COOKIE_MODE: 'secure',
    AUTH_PUBLIC_ORIGIN: 'https://api.example.com',
    AUTH_ORIGINS: 'https://app.example.com',
  });
  const server = createServer({ auth });
  t.after(() => server.close());
  const headers = { origin: 'https://app.example.com', 'x-forwarded-proto': 'https' };
  assert.equal((await server.inject({ url: '/auth/profile', headers })).statusCode, 403);
  const trusted = testAuth();
  trusted.policy = { ...auth.policy, trustProxy: ['127.0.0.1'] };
  const secure = createServer({ auth: trusted });
  t.after(() => secure.close());
  const token = await trusted.sessions.create(fixturePlayer);
  assert.equal(
    (
      await secure.inject({
        url: '/auth/profile',
        headers: { ...headers, cookie: `__Host-trivia_session=${token}` },
      })
    ).statusCode,
    200,
  );
});

test('HTTP Argon2 saturation returns 503 Retry-After without queuing verification', async (t) => {
  const f = setup(t);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.auth.login.close();
  f.auth.login = new LoginService(
    { findCredentialByUsername: async () => ({ player: fixturePlayer, passwordHash: 'fake' }) },
    () => 0,
    async () => {
      await barrier;
      return false;
    },
  );
  // installAuthentication captured the original service: create a server with the replacement.
  const server = createServer({ auth: f.auth });
  t.after(() => server.close());
  const request = () =>
    server.inject({
      method: 'POST',
      url: '/auth/login',
      headers: f.headers,
      payload: { username: 'alice', password: 'p' },
    });
  const pending = Array.from({ length: 4 }, () => request());
  await new Promise((resolve) => setImmediate(resolve));
  const result = await request();
  assert.equal(result.statusCode, 503);
  assert.equal(result.headers['retry-after'], '1');
  release();
  await Promise.all(pending);
});

test('authentication logs and errors do not disclose credentials, cookies, hashes or malformed JSON', async (t) => {
  const { Writable } = await import('node:stream');
  let logs = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk.toString();
      callback();
    },
  });
  const auth = testAuth();
  auth.login.close();
  auth.login = new LoginService(
    {
      findCredentialByUsername: async () => {
        throw new Error('SECRET_DB_HASH');
      },
    },
    () => 0,
  );
  const server = createServer({ logger: { level: 'trace', stream }, auth });
  t.after(() => server.close());
  await server.inject({
    method: 'POST',
    url: '/auth/login?password=SECRET_QUERY',
    headers: { origin, 'content-type': 'application/json', cookie: 'trivia_session=SECRET_COOKIE' },
    payload: { username: 'alice', password: 'SECRET_PASSWORD' },
  });
  await server.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin, 'content-type': 'application/json' },
    payload: '{"password":"SECRET_JSON" bad',
  });
  assert.match(logs, /AUTH_INFRASTRUCTURE_FAILURE/);
  assert.doesNotMatch(logs, /SECRET_/);
});

test('safe profile permits absent Origin/Referer; validates present Origin without refreshing or disclosing secrets', async (t) => {
  const f = setup(t);
  const login = await f.login();
  const cookie = login.headers['set-cookie'] as string;
  f.advance(idleMs - 1);
  for (const headers of [{ cookie }, { cookie, origin }]) {
    const response = await f.server.inject({ url: '/auth/profile', headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { player: fixturePlayer });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['set-cookie'], undefined);
    assert.doesNotMatch(response.body, /password|hash|token|session/i);
  }
  for (const bad of ['http://evil.test', 'null']) {
    const response = await f.server.inject({
      url: '/auth/profile',
      headers: { cookie, origin: bad },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal((await f.server.inject({ url: '/auth/profile' })).statusCode, 401);
  for (const url of ['/auth/login', '/auth/logout']) {
    assert.equal(
      (
        await f.server.inject({
          method: 'POST',
          url,
          headers: { cookie, 'content-type': 'application/json' },
          payload: { username: 'alice', password: 'p' },
        })
      ).statusCode,
      403,
    );
  }
  f.advance(idleMs);
  assert.equal(
    (await f.server.inject({ url: '/auth/profile', headers: { cookie } })).statusCode,
    401,
  );
});
