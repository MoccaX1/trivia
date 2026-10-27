import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { authenticatePlayer, provisionPlayer } from '../src/application/authenticate-player.js';
import { hashPassword, verifyPassword } from '../src/application/password.js';
import { readConfig } from '../src/config.js';
import { applyMigrations } from '../src/persistence/migrations.js';
import { PlayerPersistenceError, PlayerRepository } from '../src/persistence/players.js';
import { connectPostgres } from '../src/persistence/postgres.js';

test('Argon2id uses a fresh salt and verifies only the matching password', async () => {
  const first = await hashPassword('fixture-only-password');
  const second = await hashPassword('fixture-only-password');
  assert.notEqual(first, second);
  assert.match(first, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(await verifyPassword(first, 'fixture-only-password'), true);
  assert.equal(await verifyPassword(first, 'incorrect'), false);
});

test(
  'versioned migration and durable Player/Credential boundary use real PostgreSQL',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! });
    const pool = connectPostgres(config.database);
    const playerIds: string[] = [];
    t.after(async () => {
      try {
        if (playerIds.length) {
          await pool.query('DELETE FROM password_credential WHERE player_id = ANY($1::uuid[])', [
            playerIds,
          ]);
          await pool.query('DELETE FROM player WHERE id = ANY($1::uuid[])', [playerIds]);
        }
      } finally {
        await pool.end();
      }
    });
    const database = await pool.query<{ name: string }>('SELECT current_database() AS name');
    assert.match(
      database.rows[0]!.name,
      /_test$/,
      'TEST_DATABASE_URL must target a *_test database',
    );

    const applied = await applyMigrations(pool);
    assert.ok(applied.length === 0 || applied.includes('001_player_identity.sql'));
    assert.deepEqual(await applyMigrations(pool), []);

    const repository = new PlayerRepository(pool);
    const runId = randomUUID();
    const username = `fixture-${runId}`;
    const password = 'fixture-only-password';

    const first = await provisionPlayer(repository, username, 'First Fixture', password);
    playerIds.push(first.id);
    const second = await provisionPlayer(
      repository,
      `${username}-second`,
      'Second Fixture',
      password,
    );
    playerIds.push(second.id);
    assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(await authenticatePlayer(repository, username, password), {
      status: 'authenticated',
      player: first,
    });
    const wrong = await authenticatePlayer(repository, username, 'incorrect');
    const unknown = await authenticatePlayer(repository, `${username}-absent`, password);
    assert.deepEqual(wrong, { status: 'invalid_credentials' });
    assert.deepEqual(unknown, wrong);
    assert.equal(JSON.stringify(first).includes('password'), false);

    const stored = await pool.query<{ password_hash: string; username: string }>(
      'SELECT username, password_hash FROM password_credential WHERE player_id = $1',
      [first.id],
    );
    assert.equal(stored.rows[0]!.username, username);
    assert.notEqual(stored.rows[0]!.password_hash, password);
    assert.match(stored.rows[0]!.password_hash, /^\$argon2id\$/);

    const beforeDuplicate = await pool.query<{ count: string }>('SELECT count(*) FROM player');
    await assert.rejects(
      provisionPlayer(repository, username, 'Duplicate Fixture', password),
      (error: unknown) =>
        error instanceof PlayerPersistenceError && error.code === 'USERNAME_TAKEN',
    );
    const afterDuplicate = await pool.query<{ count: string }>('SELECT count(*) FROM player');
    assert.equal(afterDuplicate.rows[0]!.count, beforeDuplicate.rows[0]!.count);

    const credentiallessId = randomUUID();
    await pool.query('INSERT INTO player (id, display_name) VALUES ($1, $2)', [
      credentiallessId,
      'No Credential Fixture',
    ]);
    playerIds.push(credentiallessId);
    await assert.rejects(
      pool.query(
        'INSERT INTO password_credential (player_id, username, password_hash) VALUES ($1, $2, $3)',
        [first.id, `${username}-another`, stored.rows[0]!.password_hash],
      ),
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error && error.code === '23505',
    );
    await assert.rejects(
      pool.query(
        'INSERT INTO password_credential (player_id, username, password_hash) VALUES ($1, $2, $3)',
        [randomUUID(), `${username}-orphan`, stored.rows[0]!.password_hash],
      ),
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error && error.code === '23503',
    );

    const freshPool = connectPostgres(config.database);
    try {
      const freshRepository = new PlayerRepository(freshPool);
      assert.deepEqual(await freshRepository.findPlayerById(first.id), first);
      assert.deepEqual(await authenticatePlayer(freshRepository, username, password), {
        status: 'authenticated',
        player: first,
      });
      await assert.rejects(freshRepository.findPlayerById('not-a-uuid'), /Invalid Player ID/);
    } finally {
      await freshPool.end();
    }

    const closedPool = connectPostgres(config.database);
    await closedPool.end();
    await assert.rejects(
      new PlayerRepository(closedPool).findCredentialByUsername(username),
      (error: unknown) =>
        error instanceof PlayerPersistenceError &&
        error.code === 'PLAYER_STORAGE_FAILURE' &&
        !String(error).includes(password),
    );
  },
);
