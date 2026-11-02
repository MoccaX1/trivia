import { pathToFileURL } from 'node:url';
import { readConfig } from './config.js';
import { connectPostgres } from './persistence/postgres.js';
import { createServer } from './transport/server.js';
import { PlayerRepository } from './persistence/players.js';
import { LoginService } from './application/login.js';
import { MemorySessionStore } from './application/sessions.js';
import { SystemClock, NodeMatchScheduler } from './runtime/match-time.js';
import { readAuthPolicy } from './transport/auth-policy.js';

// Log stable failure codes only: driver messages/stacks can contain credentials.
function failureCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
}

export async function runBackend(
  config: ReturnType<typeof readConfig>,
  server: ReturnType<typeof createServer> | undefined = undefined,
  database = connectPostgres(config.database),
) {
  if (!server) {
    try {
      const policy = readAuthPolicy();
      const clock = new SystemClock();
      server = createServer({
        logger: { level: config.logLevel },
        auth: {
          policy,
          sessions: new MemorySessionStore(clock, new NodeMatchScheduler(clock), () =>
            server?.log.error(
              { code: 'SESSION_TIMER_FAILURE' },
              'Session invalidated after infrastructure failure',
            ),
          ),
          login: new LoginService(new PlayerRepository(database), () => clock.now()),
        },
      });
    } catch (error) {
      await database.end();
      throw error;
    }
  }
  const backend = server;
  let shutdownRequested = false;
  let resolveShutdown: () => void;
  const requested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  let deadline: NodeJS.Timeout | undefined;

  function boundShutdown() {
    deadline ??= setTimeout(() => {
      console.error('Backend shutdown exceeded 10 seconds');
      process.exit(1);
    }, 10_000);
  }
  function stop(signal: NodeJS.Signals) {
    if (shutdownRequested) return;
    shutdownRequested = true;
    backend.log.info({ signal }, 'Backend shutdown requested');
    boundShutdown();
    resolveShutdown();
  }
  function databaseError(error: unknown) {
    backend.log.error({ code: failureCode(error) }, 'Unexpected idle PostgreSQL connection error');
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  database.on('error', databaseError);

  try {
    await database.query('SELECT 1');
    if (!shutdownRequested) await backend.listen({ host: config.host, port: config.port });
    if (!shutdownRequested) await requested;
  } catch (error) {
    process.exitCode = 1;
    backend.log.error({ code: failureCode(error) }, 'Backend startup failed');
  } finally {
    // One owner/path for cleanup, including signals concurrent with a failure.
    // Keep handlers installed until cleanup finishes so repeated signals are safe.
    shutdownRequested = true;
    boundShutdown();
    let cleanupFailed = false;
    let databaseClosed = false;
    try {
      await backend.close();
    } catch (error) {
      cleanupFailed = true;
      process.exitCode = 1;
      backend.log.error({ code: failureCode(error) }, 'HTTP/realtime cleanup failed');
    }
    try {
      await database.end();
      databaseClosed = true;
    } catch (error) {
      cleanupFailed = true;
      process.exitCode = 1;
      backend.log.error({ code: failureCode(error) }, 'PostgreSQL cleanup failed');
    } finally {
      // A failed close may leave live resources. Keep the bound in that case,
      // but do not let the timer itself delay an otherwise natural failure exit.
      if (cleanupFailed) deadline?.unref();
      else clearTimeout(deadline);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      if (databaseClosed) database.off('error', databaseError);
    }
    backend.log.info('Backend shutdown complete');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runBackend(readConfig());
  } catch {
    // Configuration/construction errors occur before logging is available.
    console.error('Backend initialization failed; check configuration');
    process.exitCode = 1;
  }
}
