import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { io } from 'socket.io-client';
import { createServer } from '../src/transport/server.js';
import { LoginService } from '../src/application/login.js';
import { testAuth } from './support/auth.js';
import { readConfig } from '../src/config.js';
import { connectPostgres } from '../src/persistence/postgres.js';
import { applyMigrations } from '../src/persistence/migrations.js';
import { PlayerRepository } from '../src/persistence/players.js';
import { provisionPlayer, authenticatePlayer } from '../src/application/authenticate-player.js';

// Only a verified *_test DB and a fresh random schema are touched. No reset of public schema.
for (const kind of ['collision', 'invalid-existing', 'preservation'] as const) {
  test(
    `migration 002: ${kind}, transactional rollback, ledger integrity and concurrent execution`,
    { skip: !process.env.TEST_DATABASE_URL },
    async (t) => {
      const base = connectPostgres(
        readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }).database,
      );
      let cleanup = () => base.end();
      t.after(() => cleanup());
      assert.match((await base.query('SELECT current_database() AS name')).rows[0].name, /_test$/);
      const schema = 'identity_' + randomUUID().replaceAll('-', '');
      await base.query(`CREATE SCHEMA ${schema}`);
      const pool = new pg.Pool({
        ...readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }).database,
        options: `-c search_path=${schema}`,
      });
      cleanup = async () => {
        try {
          await pool.end();
          await base.query(`DROP SCHEMA ${schema} CASCADE`);
        } finally {
          await base.end();
        }
      };
      const initial = await readFile(
        new URL('../migrations/001_player_identity.sql', import.meta.url),
        'utf8',
      );
      await pool.query(initial);
      await pool.query(
        'CREATE TABLE schema_migration (version TEXT PRIMARY KEY, checksum TEXT NOT NULL)',
      );
      const checksum = createHash('sha256').update(initial).digest('hex');
      await pool.query('INSERT INTO schema_migration VALUES ($1, $2)', [
        '001_player_identity.sql',
        checksum,
      ]);
      const id = randomUUID();
      await pool.query('INSERT INTO player VALUES ($1,$2)', [id, 'Đặng 👩‍👩‍👧‍👦']);
      await pool.query('INSERT INTO password_credential VALUES ($1,$2,$3)', [
        id,
        kind === 'invalid-existing' ? 'has space' : 'Alice',
        'legacy-hash',
      ]);
      if (kind === 'collision') {
        const other = randomUUID();
        await pool.query('INSERT INTO player VALUES ($1,$2)', [other, 'Other']);
        await pool.query('INSERT INTO password_credential VALUES ($1,$2,$3)', [
          other,
          'alice',
          'other-hash',
        ]);
      }
      if (kind !== 'preservation') {
        await assert.rejects(
          applyMigrations(pool),
          new RegExp(
            kind === 'collision' ? 'USERNAME_CANONICAL_COLLISION' : 'USERNAME_INVALID_EXISTING',
          ),
        );
        assert.equal(
          (await pool.query('SELECT count(*) FROM schema_migration')).rows[0].count,
          '1',
        );
        assert.equal(
          (await pool.query('SELECT username FROM password_credential WHERE player_id=$1', [id]))
            .rows[0].username,
          kind === 'collision' ? 'Alice' : 'has space',
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM pg_constraint WHERE connamespace=$1::regnamespace AND conname='password_credential_username_canonical'",
              [schema],
            )
          ).rows[0].count,
          '0',
        );
        return;
      }
      const results = await Promise.all([applyMigrations(pool), applyMigrations(pool)]);
      assert.deepEqual(results.flat(), ['002_canonical_username.sql']);
      assert.deepEqual(
        (await pool.query('SELECT player_id, username,password_hash FROM password_credential'))
          .rows,
        [{ player_id: id, username: 'alice', password_hash: 'legacy-hash' }],
      );
      assert.equal(
        (
          await pool.query('SELECT checksum FROM schema_migration WHERE version=$1', [
            '001_player_identity.sql',
          ])
        ).rows[0].checksum,
        checksum,
      );
      assert.deepEqual(await applyMigrations(pool), []);
      const repo = new PlayerRepository(pool);
      const player = await provisionPlayer(repo, 'BoB', ' Nguyễn 👩‍💻 ', 'fixture-only-password');
      for (const name of ['bob', 'BOB', 'BoB'])
        assert.deepEqual(await authenticatePlayer(repo, name, 'fixture-only-password'), {
          status: 'authenticated',
          player,
        });
      await assert.rejects(
        provisionPlayer(repo, 'BOB', 'Other', 'fixture-only-password'),
        /USERNAME_TAKEN/,
      );
      await assert.rejects(
        pool.query('UPDATE password_credential SET username=$1 WHERE player_id=$2', [
          'BoB',
          player.id,
        ]),
      );
      const auth = testAuth();
      auth.login.close();
      auth.login = new LoginService(repo, () => Date.now());
      const server = createServer({ auth });
      try {
        const address = await server.listen({ host: '127.0.0.1', port: 0 });
        const response = await fetch(address + '/auth/login', {
          method: 'POST',
          headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'BOB', password: 'fixture-only-password' }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { player });
        const cookie = response.headers.get('set-cookie')!;
        const profile = await fetch(address + '/auth/profile', {
          headers: { Origin: 'http://localhost', Cookie: cookie },
        });
        assert.deepEqual(await profile.json(), { player });
        for (const transport of ['polling', 'websocket']) {
          const socket = io(address, {
            transports: [transport],
            extraHeaders: { Origin: 'http://localhost', Cookie: cookie },
            reconnection: false,
            autoConnect: false,
          });
          try {
            const connected = new Promise<void>((resolve, reject) => {
              socket.once('connect', resolve);
              socket.once('connect_error', reject);
            });
            socket.connect();
            await connected;
          } finally {
            socket.disconnect();
          }
        }
      } finally {
        await server.close();
      }
      await pool.query('UPDATE schema_migration SET checksum=$1 WHERE version=$2', [
        'tampered',
        '002_canonical_username.sql',
      ]);
      await assert.rejects(applyMigrations(pool), /MIGRATION_CHECKSUM_MISMATCH/);
    },
  );
}
