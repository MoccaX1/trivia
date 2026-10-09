import pg from 'pg';

// Connection infrastructure only; no schema, repository, or active Match storage.
export function connectPostgres(connectionString: string) {
  return new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
  });
}
