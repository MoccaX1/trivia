import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../src/config.js';

const databaseUrl = 'postgresql://trivia:local@localhost:5432/trivia';

test('configuration defaults and explicit listener settings', () => {
  assert.deepEqual(readConfig({ DATABASE_URL: databaseUrl }), {
    host: '127.0.0.1',
    port: 3000,
    logLevel: 'info',
    databaseUrl,
  });
  assert.equal(readConfig({ DATABASE_URL: databaseUrl, PORT: '4000' }).port, 4000);
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
