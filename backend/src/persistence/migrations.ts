import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const migrationDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));

function migrationError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** Apply versioned SQL explicitly; callers own the Pool lifecycle. */
export async function applyMigrations(pool: pg.Pool): Promise<readonly string[]> {
  const files = (await readdir(migrationDirectory))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (files.length === 0) throw migrationError('NO_MIGRATIONS');

  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query('BEGIN');
    // Serialize explicit migration runs in this database, including ledger creation.
    await client.query('SELECT pg_advisory_xact_lock(7416601)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL
      )
    `);
    const applied = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migration',
    );
    const installed = new Map(applied.rows.map(({ version, checksum }) => [version, checksum]));
    if ([...installed.keys()].some((version) => !files.includes(version))) {
      throw migrationError('UNKNOWN_MIGRATION_VERSION');
    }

    const added: string[] = [];
    for (const version of files) {
      const sql = await readFile(new URL(`../../migrations/${version}`, import.meta.url), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = installed.get(version);
      if (previous !== undefined) {
        if (previous !== checksum) throw migrationError('MIGRATION_CHECKSUM_MISMATCH');
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migration (version, checksum) VALUES ($1, $2)', [
        version,
        checksum,
      ]);
      added.push(version);
    }
    await client.query('COMMIT');
    return added;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discardClient = true;
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}
