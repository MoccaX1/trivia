const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const portText = env.PORT ?? '3000';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const host = env.HOST ?? '127.0.0.1';
  if (!host.trim()) throw new Error('HOST must not be empty');

  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!logLevels.some((level) => level === logLevel)) {
    throw new Error('LOG_LEVEL must be a supported logger level');
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }

  // Decode components once here, rather than letting pg merge a partial URI
  // with ambient PG* variables. Empty credentials would enable pg fallbacks.
  let user: string;
  let password: string;
  let database: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error('DATABASE_URL contains invalid percent encoding');
  }
  if (!user || !password || !database) {
    throw new Error('DATABASE_URL must include a username, password, and database');
  }
  const databasePort = Number(url.port || '5432');
  if (!Number.isInteger(databasePort) || databasePort < 1 || databasePort > 65535) {
    throw new Error('DATABASE_URL contains an invalid port');
  }
  const sslmode = url.searchParams.get('sslmode') ?? 'disable';
  if (
    !['disable', 'verify-full'].includes(sslmode) ||
    [...url.searchParams.keys()].some((key) => key !== 'sslmode') ||
    url.searchParams.getAll('sslmode').length > 1
  ) {
    throw new Error('DATABASE_URL supports only sslmode=disable or sslmode=verify-full');
  }

  return {
    host,
    port,
    logLevel,
    database: {
      host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: databasePort,
      user,
      password,
      database,
      ssl: sslmode === 'verify-full',
    },
  };
}
