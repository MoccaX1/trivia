import { readConfig } from '../dist/config.js';
import { applyMigrations } from '../dist/persistence/migrations.js';
import { connectPostgres } from '../dist/persistence/postgres.js';

let pool;
try {
  pool = connectPostgres(readConfig().database);
  const applied = await applyMigrations(pool);
  console.log(
    applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Migrations already current',
  );
} catch (error) {
  // PostgreSQL and URL error messages can contain secrets. Report a stable code only.
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{1,32}$/.test(error.code)
      ? error.code
      : 'MIGRATION_FAILED';
  const knownPreflight =
    error &&
    typeof error === 'object' &&
    'message' in error &&
    ['USERNAME_CANONICAL_COLLISION', 'USERNAME_INVALID_EXISTING'].includes(error.message)
      ? error.message
      : code;
  console.error(`Migration failed: ${knownPreflight}`);
  process.exitCode = 1;
} finally {
  if (pool) {
    try {
      await pool.end();
    } catch {
      console.error('PostgreSQL migration connection cleanup failed');
      process.exitCode = 1;
    }
  }
}
