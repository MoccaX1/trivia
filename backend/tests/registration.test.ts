import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Writable } from 'node:stream';
import {
  RegistrationService,
  registrationInput,
  registrationLimits,
} from '../src/application/registration.js';
import { provisionPlayer } from '../src/application/authenticate-player.js';
import { LoginService } from '../src/application/login.js';
import { verifyPassword } from '../src/application/password.js';
import { PlayerPersistenceError, PlayerRepository } from '../src/persistence/players.js';
import { connectPostgres } from '../src/persistence/postgres.js';
import { applyMigrations } from '../src/persistence/migrations.js';
import { readConfig } from '../src/config.js';
import { readAuthPolicy } from '../src/transport/auth-policy.js';
import { createServer } from '../src/transport/server.js';
import { fixturePlayer, testAuth } from './support/auth.js';

const body = { username: 'Alice', displayName: ' Nguyễn 👩‍💻 ', password: ' exact password 👩‍💻 ' };
const headers = { origin: 'http://localhost', 'content-type': 'application/json' };
const repository = { createPlayerWithCredential: async () => fixturePlayer };
function setup(
  t: TestContext,
  create: typeof provisionPlayer = async () => fixturePlayer,
  now = () => 0,
) {
  const registration = new RegistrationService(repository, now, create);
  const auth = { ...testAuth(), registration };
  const server = createServer({ auth });
  t.after(() => server.close());
  const send = (payload: unknown = body, url = '/auth/register') =>
    server.inject({ method: 'POST', url, headers, payload: payload as object });
  return { server, auth, registration, send };
}

test('registration returns public identity, no cookie, and preserves an existing session without refresh', async (t) => {
  const f = setup(t);
  const token = await f.auth.sessions.create(fixturePlayer);
  const response = await f.server.inject({
    method: 'POST',
    url: '/auth/register',
    headers: { ...headers, cookie: `trivia_session=${token}` },
    payload: body,
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), { player: fixturePlayer });
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(await f.auth.sessions.resolve(token), fixturePlayer);
  assert.equal((await f.server.inject({ url: '/auth/profile' })).statusCode, 401);
});

for (const [name, payload] of [
  ['14 code points', { ...body, password: '😀'.repeat(14) }],
  ['empty password', { ...body, password: '' }],
  ['1025 bytes', { ...body, password: 'a'.repeat(1025) }],
  ['emoji byte overflow', { ...body, password: '😀'.repeat(257) }],
  ['username whitespace', { ...body, username: ' alice' }],
  ['username newline', { ...body, username: 'alice\n' }],
  ['username Unicode', { ...body, username: 'é' }],
  ['username 129', { ...body, username: 'a'.repeat(129) }],
  ['empty username', { ...body, username: '' }],
  ['blank display name', { ...body, displayName: '  ' }],
  ['display control', { ...body, displayName: 'a\u0000b' }],
  ['display bidi', { ...body, displayName: 'a\u202eb' }],
  ['display surrogate', { ...body, displayName: '\ud800' }],
  ['display 65', { ...body, displayName: '👩‍💻'.repeat(65) }],
  ['missing field', { username: 'alice', password: body.password }],
  ['wrong type', { ...body, password: 17 }],
  ['extra confirmation', { ...body, confirmPassword: body.password }],
  ['spoof identity', { ...body, playerId: fixturePlayer.id }],
  ['array', [body]],
] as const) {
  test(`registration rejects ${name} without starting provisioning`, async (t) => {
    let calls = 0;
    const f = setup(t, async () => {
      calls++;
      return fixturePlayer;
    });
    assert.equal((await f.send(payload)).statusCode, 400);
    assert.equal(calls, 0);
  });
}
for (const password of [
  '😀'.repeat(15),
  '😀'.repeat(256),
  'a'.repeat(1024),
  '               ',
  'e\u0301'.repeat(8),
]) {
  test(`registration preserves a valid ${Buffer.byteLength(password)}-byte password exactly`, async (t) => {
    let captured = '';
    const f = setup(t, async (_repo, username, name, value) => {
      assert.equal(username, 'alice');
      assert.equal(name, body.displayName);
      captured = value;
      return fixturePlayer;
    });
    assert.equal((await f.send({ ...body, password })).statusCode, 201);
    assert.equal(captured, password);
  });
}
test('identity upper bounds remain 128 username characters and 64 graphemes', () => {
  assert.ok(
    registrationInput({ ...body, username: 'X'.repeat(128), displayName: '👩‍💻'.repeat(64) }),
  );
});

for (const origin of [undefined, 'null', 'https://evil.example', 'http://localhost:4444']) {
  test(`registration rejects Origin ${String(origin)} for normal and encoded routes`, async (t) => {
    let calls = 0;
    const f = setup(t, async () => {
      calls++;
      return fixturePlayer;
    });
    for (const url of ['/auth/register', '/%61uth/register', '/auth/%72egister']) {
      const response = await f.server.inject({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          ...(origin === undefined ? {} : { origin }),
        },
        payload: body,
      });
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.json(), { code: 'ORIGIN_FORBIDDEN' });
    }
    assert.equal(calls, 0);
  });
}
test('encoded routes share registration validation, admission and response semantics', async (t) => {
  const f = setup(t);
  for (const url of ['/auth/register', '/%61uth/register', '/auth/%72egister'])
    assert.equal((await f.send(body, url)).statusCode, 201);
});
test('untrusted direct clients cannot manufacture HTTPS or trusted IP using forwarding headers', async (t) => {
  const f = setup(t);
  f.auth.policy.local = false;
  f.auth.policy.publicOrigin = 'https://localhost';
  f.auth.policy.origins = ['https://localhost'];
  for (const url of ['/auth/register', '/auth/%72egister']) {
    const response = await f.server.inject({
      method: 'POST',
      url,
      headers: {
        ...headers,
        origin: 'https://localhost',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '127.0.0.1',
        forwarded: 'proto=https',
      },
      payload: body,
    });
    assert.equal(response.statusCode, 403);
  }
  f.auth.policy.trustProxy = ['127.0.0.1/32'];
  assert.equal(
    (
      await f.server.inject({
        method: 'POST',
        url: '/auth/register',
        headers: { ...headers, origin: 'https://localhost', 'x-forwarded-proto': 'https' },
        payload: body,
      })
    ).statusCode,
    201,
  );
});
test('registration retains approved HTTPS preflight and rejects cross-site configuration', () => {
  assert.throws(() =>
    readAuthPolicy({
      AUTH_COOKIE_MODE: 'secure',
      AUTH_PUBLIC_ORIGIN: 'https://trivia.example',
      AUTH_ORIGINS: 'https://evil.example',
    }),
  );
});
test('registration rejects incorrect content type, malformed JSON and oversized bodies before provisioning', async (t) => {
  let calls = 0;
  const f = setup(t, async () => {
    calls++;
    return fixturePlayer;
  });
  for (const [payload, type, status] of [
    [JSON.stringify(body), 'text/plain', 415],
    ['{"password":"SECRET" bad', 'application/json', 400],
    [JSON.stringify(body) + ' '.repeat(4096), 'application/json', 413],
  ] as const) {
    const response = await f.server.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { origin: headers.origin, 'content-type': type },
      payload,
    });
    assert.equal(response.statusCode, status);
    assert.doesNotMatch(response.body, /SECRET|SyntaxError|stack/);
  }
  assert.equal(calls, 0);
});

test('IP quota includes malformed requests and expires exactly at 15 minutes without trusting forwarded IP', async (t) => {
  let now = 0;
  let calls = 0;
  const f = setup(
    t,
    async () => {
      calls++;
      return fixturePlayer;
    },
    () => now,
  );
  for (let i = 0; i < 20; i++) assert.equal((await f.send({})).statusCode, 400);
  const response = await f.server.inject({
    method: 'POST',
    url: '/auth/%72egister',
    headers: { ...headers, 'x-forwarded-for': '198.51.100.99' },
    payload: body,
  });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['retry-after'], '900');
  assert.equal(calls, 0);
  now = 899999;
  assert.equal((await f.send()).statusCode, 429);
  now = 900000;
  assert.equal((await f.send()).statusCode, 201);
});
test('global quota bounds distributed registration attempts and expires at one hour', async (t) => {
  let now = 0;
  const f = setup(t, undefined, () => now);
  for (let i = 0; i < 100; i++) assert.equal(f.registration.admitIp(`ip-${i}`), undefined);
  assert.deepEqual(f.registration.admitIp('new-ip'), { status: 'rate_limited', retryAfter: 3600 });
  now = 3599999;
  assert.equal(f.registration.admitIp('new-ip')?.status, 'rate_limited');
  now = 3600000;
  assert.equal(f.registration.admitIp('new-ip'), undefined);
});
test('registration slots fail fast and release after success, rejection and abort', async (t) => {
  let resolve!: () => void;
  let reject = false;
  let calls = 0;
  const wait = new Promise<void>((r) => {
    resolve = r;
  });
  const f = setup(t, async () => {
    calls++;
    await wait;
    if (reject) throw new Error('controlled');
    return fixturePlayer;
  });
  const first = f.registration.register(body);
  const second = f.registration.register(body);
  assert.deepEqual(await f.registration.register(body), { status: 'busy' });
  resolve();
  assert.equal((await first).status, 'created');
  assert.equal((await second).status, 'created');
  reject = true;
  await assert.rejects(f.registration.register(body));
  reject = false;
  assert.equal((await f.registration.register(body)).status, 'created');
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await f.registration.register(body, controller.signal), { status: 'busy' });
  assert.equal(calls, 4);
});
test('disconnect retains native-work capacity until completion and shutdown drains admitted work', async (t) => {
  let resolve!: () => void;
  const wait = new Promise<void>((r) => {
    resolve = r;
  });
  const f = setup(t, async () => {
    await wait;
    return fixturePlayer;
  });
  const controller = new AbortController();
  const first = f.registration.register(body, controller.signal);
  const second = f.registration.register(body);
  await Promise.resolve();
  controller.abort();
  assert.deepEqual(await f.registration.register(body), { status: 'busy' });
  const closing = f.registration.close();
  assert.equal(f.registration.admitIp('ip')?.status, 'busy');
  assert.deepEqual(await f.registration.register(body), { status: 'busy' });
  resolve();
  await Promise.all([first, second, closing]);
  await f.registration.close();
});
for (const code of ['USERNAME_TAKEN', 'PLAYER_STORAGE_FAILURE', 'unexpected'] as const) {
  test(`registration safely maps ${code} and recovers capacity`, async (t) => {
    let fail = true;
    const f = setup(t, async () => {
      if (fail)
        throw code === 'unexpected' ? new Error('SECRET') : new PlayerPersistenceError(code);
      return fixturePlayer;
    });
    const response = await f.send();
    assert.equal(
      response.statusCode,
      code === 'USERNAME_TAKEN' ? 409 : code === 'PLAYER_STORAGE_FAILURE' ? 503 : 500,
    );
    assert.doesNotMatch(response.body, /SECRET|SQL|playerId/);
    fail = false;
    assert.equal((await f.send()).statusCode, 201);
  });
}
test('registration does not log credentials, cookies, hashes or parser/storage diagnostics', async (t) => {
  let logs = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logs += chunk.toString();
      done();
    },
  });
  const auth = {
    ...testAuth(),
    registration: new RegistrationService(
      repository,
      () => 0,
      async () => {
        throw new PlayerPersistenceError('PLAYER_STORAGE_FAILURE');
      },
    ),
  };
  const server = createServer({ auth, logger: { level: 'trace', stream } });
  t.after(() => server.close());
  const response = await server.inject({
    method: 'POST',
    url: '/auth/register?password=SECRET_QUERY',
    headers: { ...headers, cookie: 'trivia_session=SECRET_COOKIE' },
    payload: { ...body, password: 'SECRET_PASSWORD_LONG' },
  });
  assert.equal(response.statusCode, 503);
  assert.match(logs, /REGISTRATION_STORAGE_FAILURE/);
  assert.doesNotMatch(logs, /SECRET_/);
});

test(
  'real PostgreSQL registration: Argon2, canonical race, atomic rollback, no session and legacy login',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const database = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }).database;
    const base = connectPostgres(database);
    assert.match((await base.query('SELECT current_database() AS name')).rows[0].name, /_test$/);
    const schema = 'registration_' + randomUUID().replaceAll('-', '');
    await base.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ ...database, options: `-c search_path=${schema}` });
    const ids: string[] = [];
    t.after(async () => {
      try {
        await pool.end();
        await base.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await base.end();
      }
    });
    await applyMigrations(pool);
    const repo = new PlayerRepository(pool);
    const auth = { ...testAuth(), registration: new RegistrationService(repo, () => 0) };
    auth.login.close();
    auth.login = new LoginService(repo, () => 0);
    const server = createServer({ auth });
    t.after(() => server.close());
    const username = 'reg_' + randomUUID().replaceAll('-', '');
    const password = ' exact pássword 👩‍💻 ';
    const before = (await pool.query('SELECT count(*) FROM player')).rows[0].count;
    const responses = await Promise.all(
      [username.toUpperCase(), username].map((name) =>
        server.inject({
          method: 'POST',
          url: '/auth/register',
          headers,
          payload: { ...body, username: name, password },
        }),
      ),
    );
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [201, 409]);
    const success = responses.find((r) => r.statusCode === 201)!;
    const player = success.json().player;
    ids.push(player.id);
    assert.equal(success.headers['set-cookie'], undefined);
    assert.equal((await server.inject({ url: '/auth/profile' })).statusCode, 401);
    const stored = (
      await pool.query(
        'SELECT username,password_hash FROM password_credential WHERE player_id=$1',
        [player.id],
      )
    ).rows[0];
    assert.equal(stored.username, username);
    assert.match(stored.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    assert.equal(await verifyPassword(stored.password_hash, password), true);
    assert.equal(await verifyPassword(stored.password_hash, password.trim()), false);
    assert.equal(
      Number((await pool.query('SELECT count(*) FROM player')).rows[0].count),
      Number(before) + 1,
    );
    const login = await server.inject({
      method: 'POST',
      url: '/auth/login',
      headers,
      payload: { username: username.toUpperCase(), password },
    });
    assert.equal(login.statusCode, 200);
    const legacy = await provisionPlayer(repo, username + '_legacy', 'Legacy', 'p');
    ids.push(legacy.id);
    assert.equal(
      (
        await server.inject({
          method: 'POST',
          url: '/auth/login',
          headers,
          payload: { username: username + '_legacy', password: 'p' },
        })
      ).statusCode,
      200,
    );
    const ambiguousAuth = {
      ...testAuth(),
      registration: new RegistrationService(
        repo,
        () => 0,
        async (...args) => {
          const created = await provisionPlayer(...args);
          ids.push(created.id);
          throw new PlayerPersistenceError('PLAYER_STORAGE_FAILURE');
        },
      ),
    };
    const ambiguousServer = createServer({ auth: ambiguousAuth });
    t.after(() => ambiguousServer.close());
    const ambiguousBody = { ...body, username: username + '_uncertain', password };
    const uncertain = await ambiguousServer.inject({
      method: 'POST',
      url: '/auth/register',
      headers,
      payload: ambiguousBody,
    });
    assert.equal(uncertain.statusCode, 503);
    assert.ok(await repo.findCredentialByUsername(ambiguousBody.username));
    assert.equal(
      (
        await ambiguousServer.inject({
          method: 'POST',
          url: '/auth/register',
          headers,
          payload: ambiguousBody,
        })
      ).statusCode,
      409,
    );
    assert.equal(registrationLimits.concurrent, 2);
  },
);
