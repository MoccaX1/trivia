import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import pg from 'pg';
import { readConfig } from '../src/config.js';
import { connectPostgres } from '../src/persistence/postgres.js';

function poisonPgEnvironment(t: TestContext) {
  const values = {
    PGHOST: 'wrong.invalid',
    PGPORT: '1',
    PGUSER: 'wrong',
    PGPASSWORD: 'wrong',
    PGDATABASE: 'wrong',
    PGSSLMODE: 'require',
    PGSSLNEGOTIATION: 'direct',
    PGOPTIONS: '-c nonexistent_parameter=1',
    PGAPPNAME: 'wrong',
    PGCLIENT_ENCODING: 'SQL_ASCII',
    PGREPLICATION: 'database',
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

test('pg receives explicit URL settings even with conflicting PG environment', async (t) => {
  poisonPgEnvironment(t);
  const config = readConfig({
    DATABASE_URL: 'postgresql://user:p%40ss%3A%2F%3F%23%25%24@localhost/db',
  });
  const pool = connectPostgres(config.database);
  t.after(() => pool.end());
  const client = new pg.Client(pool.options);
  assert.equal(client.user, 'user');
  assert.equal(client.password, 'p@ss:/?#%$');
  assert.equal(client.database, 'db');
  assert.equal(client.host, 'localhost');
  assert.equal(client.port, 5432);
  assert.equal(client.ssl, false);
});

test(
  'PostgreSQL authenticates URL credentials with PG fallbacks poisoned',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async (t) => {
    poisonPgEnvironment(t);
    const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! });
    const pool = connectPostgres(config.database);
    t.after(() => pool.end());
    const result = await pool.query<{ username: string; database: string; encoding: string }>(
      "SELECT current_user AS username, current_database() AS database, current_setting('client_encoding') AS encoding",
    );
    assert.deepEqual(result.rows, [
      {
        username: config.database.user,
        database: config.database.database,
        encoding: 'UTF8',
      },
    ]);
  },
);
