import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../src/config.js';

const databaseUrl = 'postgresql://trivia:local@localhost:5432/trivia';

test('configuration defaults and explicit listener settings', () => {
  assert.deepEqual(readConfig({ DATABASE_URL: databaseUrl }), {
    host: '127.0.0.1',
    port: 3000,
    logLevel: 'info',
    database: {
      host: 'localhost',
      port: 5432,
      user: 'trivia',
      password: 'local',
      database: 'trivia',
      ssl: false,
    },
  });
  assert.equal(readConfig({ DATABASE_URL: databaseUrl, PORT: '4000' }).port, 4000);
});

test('database URL is complete, explicitly decoded, and independent of PG variables', () => {
  const user = 'u:@/?#%$+ space';
  const password = 'p:@/?#%$+ space';
  const database = 'db/@?#%+ space';
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@[::1]/${encodeURIComponent(database)}`;
  assert.deepEqual(readConfig({ DATABASE_URL: url, PGPORT: '9999', PGUSER: 'wrong' }).database, {
    host: '::1',
    port: 5432,
    user,
    password,
    database,
    ssl: false,
  });
  assert.equal(readConfig({ DATABASE_URL: url + '?sslmode=verify-full' }).database.ssl, true);
  for (const incomplete of [
    'postgresql://localhost/trivia',
    'postgresql://user@localhost/trivia',
    'postgresql://:password@localhost/trivia',
    'postgresql://user:password@localhost',
    'postgresql://user:%XX@localhost/trivia',
    url + '?user=override',
    url + '?sslmode=no-verify',
    url + '?sslmode=disable&sslmode=verify-full',
    url + '#secret',
  ]) {
    assert.throws(() => readConfig({ DATABASE_URL: incomplete }), /DATABASE_URL/);
  }
});

test('invalid configuration fails without exposing database credentials', () => {
  for (const port of ['0', '-1', '65536', '3000.5', 'abc', '']) {
    assert.throws(() => readConfig({ DATABASE_URL: databaseUrl, PORT: port }), /PORT/);
  }
  assert.throws(() => readConfig({}), /DATABASE_URL is required/);
  assert.throws(() => readConfig({ DATABASE_URL: 'http://secret:password@localhost' }), {
    message: 'DATABASE_URL must be a PostgreSQL URL',
  });
  assert.throws(() => readConfig({ DATABASE_URL: databaseUrl, LOG_LEVEL: 'invalid' }), /LOG_LEVEL/);
  assert.throws(() => readConfig({ DATABASE_URL: databaseUrl, HOST: '' }), /HOST/);
});
