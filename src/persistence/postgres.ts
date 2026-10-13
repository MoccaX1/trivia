import pg from 'pg';
import type { readConfig } from '../config.js';

// Connection infrastructure only; no schema, repository, or active Match storage.
export function connectPostgres(database: ReturnType<typeof readConfig>['database']) {
  const options = {
    ...database,
    max: 5,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    application_name: 'trivia-backend',
    client_encoding: 'UTF8',
    sslnegotiation: 'postgres' as const,
    replication: 'false',
    // pg treats an empty options string as missing; whitespace explicitly means
    // no server options and prevents ambient PGOPTIONS from changing startup.
    options: ' ',
  };
  return new pg.Pool(options);
}
