import { randomUUID } from 'node:crypto';
import { canonicalUsername, validateDisplayName } from '../application/player-identity.js';
import type pg from 'pg';
import type { PlayerProfile } from '../application/authenticate-player.js';

export interface CredentialForVerification {
  readonly player: PlayerProfile;
  readonly passwordHash: string;
}

export class PlayerPersistenceError extends Error {
  constructor(readonly code: 'USERNAME_TAKEN' | 'PLAYER_STORAGE_FAILURE') {
    super(code);
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function storageError(error: unknown): PlayerPersistenceError {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'password_credential_username_key'
  ) {
    return new PlayerPersistenceError('USERNAME_TAKEN');
  }
  return new PlayerPersistenceError('PLAYER_STORAGE_FAILURE');
}

/** SQL is private to this adapter; password hashes are returned only to the trusted verifier. */
export class PlayerRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findCredentialByUsername(username: string): Promise<CredentialForVerification | null> {
    username = canonicalUsername(username);
    try {
      const result = await this.pool.query<{
        id: string;
        display_name: string;
        password_hash: string;
      }>(
        `SELECT p.id, p.display_name, c.password_hash
         FROM password_credential c JOIN player p ON p.id = c.player_id
         WHERE c.username = $1`,
        [username],
      );
      const row = result.rows[0];
      return row
        ? {
            player: Object.freeze({ id: row.id, displayName: row.display_name }),
            passwordHash: row.password_hash,
          }
        : null;
    } catch (error) {
      throw storageError(error);
    }
  }

  async findPlayerById(playerId: string): Promise<PlayerProfile | null> {
    if (!uuidPattern.test(playerId)) throw new TypeError('Invalid Player ID');
    try {
      const result = await this.pool.query<{ id: string; display_name: string }>(
        'SELECT id, display_name FROM player WHERE id = $1',
        [playerId],
      );
      const row = result.rows[0];
      return row ? Object.freeze({ id: row.id, displayName: row.display_name }) : null;
    } catch (error) {
      throw storageError(error);
    }
  }

  /** Internal provisioning only; the caller supplies an already-hashed password. */
  async createPlayerWithCredential(
    username: string,
    displayName: string,
    passwordHash: string,
  ): Promise<PlayerProfile> {
    username = canonicalUsername(username);
    validateDisplayName(displayName);
    const player = Object.freeze({ id: randomUUID(), displayName });
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw storageError(error);
    }
    let discardClient = false;
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO player (id, display_name) VALUES ($1, $2)', [
        player.id,
        player.displayName,
      ]);
      await client.query(
        'INSERT INTO password_credential (player_id, username, password_hash) VALUES ($1, $2, $3)',
        [player.id, username, passwordHash],
      );
      await client.query('COMMIT');
      return player;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discardClient = true;
      }
      throw storageError(error);
    } finally {
      client.release(discardClient);
    }
  }
}
