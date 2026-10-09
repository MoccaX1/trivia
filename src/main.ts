import { readConfig } from './config.js';
import { connectPostgres } from './persistence/postgres.js';
import { createServer } from './transport/server.js';

async function main() {
  const config = readConfig();
  const server = createServer({ logger: { level: config.logLevel } });
  const database = connectPostgres(config.databaseUrl);

  database.on('error', (err) => {
    server.log.error({ err }, 'Unexpected idle PostgreSQL connection error');
  });
  server.addHook('onClose', async () => {
    await database.end();
  });

  let shutdownRequested = false;
  const startup = (async () => {
    // Fail startup promptly if the configured database cannot be reached.
    await database.query('SELECT 1');
    if (!shutdownRequested) {
      await server.listen({ host: config.host, port: config.port });
    }
  })();

  let shutdown: Promise<void> | undefined;
  function stop(signal: NodeJS.Signals) {
    if (shutdown) return;
    shutdownRequested = true;
    server.log.info({ signal }, 'Backend shutdown started');
    const deadline = setTimeout(() => {
      server.log.error('Backend shutdown exceeded 10 seconds');
      process.exit(1);
    }, 10_000);
    deadline.unref();

    // Close resources after startup settles, even if interrupted or failed.
    shutdown = startup
      .then(
        () => server.close(),
        () => server.close(),
      )
      .then(
        () => {
          clearTimeout(deadline);
          server.log.info('Backend shutdown complete');
        },
        (err: unknown) => {
          clearTimeout(deadline);
          server.log.error({ err }, 'Backend shutdown failed');
          process.exitCode = 1;
        },
      );
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    await startup;
  } catch (err) {
    server.log.error({ err }, 'Backend startup failed');
    await server.close();
    throw err;
  }
}

main().catch((err: unknown) => {
  // Configuration errors occur before the structured logger is available.
  console.error('Backend failed:', err instanceof Error ? err.message : 'Unknown startup error');
  process.exitCode = 1;
});
