import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readConfig } from './config.js';
import { connectPostgres } from './persistence/postgres.js';
import { createServer } from './transport/server.js';
import { PlayerRepository } from './persistence/players.js';
import { RegistrationService } from './application/registration.js';
import { LoginService } from './application/login.js';
import { MemorySessionStore } from './application/sessions.js';
import { SystemClock, NodeMatchScheduler } from './runtime/match-time.js';
import { readAuthPolicy } from './transport/auth-policy.js';
import { MatchCoordinator } from './application/match-coordinator.js';
import { MatchCompletions } from './application/match-completions.js';
import { CompletedMatchRepository } from './persistence/completed-matches.js';
import { HistoryRepository } from './persistence/history.js';

// Log stable failure codes only: driver messages/stacks can contain credentials.
function failureCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
}

export async function runBackend(
  config: ReturnType<typeof readConfig>,
  server: ReturnType<typeof createServer> | undefined = undefined,
  database = connectPostgres(config.database),
  completions: MatchCompletions | undefined = undefined,
) {
  if (!server) {
    try {
      const policy = readAuthPolicy();
      const clock = new SystemClock();
      const scheduler = new NodeMatchScheduler(clock);
      const players = new PlayerRepository(database);
      completions = new MatchCompletions(new CompletedMatchRepository(database), (outcome) => {
        const context = { ...outcome, operation: 'completion-save' };
        if (outcome.status === 'succeeded') server?.log.info(context, 'Match completion committed');
        else server?.log.error(context, 'Match completion not confirmed');
      });
      const coordinator = new MatchCoordinator(
        clock,
        scheduler,
        randomUUID,
        ({ matchId }) => {
          const found = coordinator.lookup(matchId);
          server?.log.error(
            {
              code: 'MATCH_TIMER_FAILURE',
              matchId,
              phase: found.status === 'found' ? found.match.phase : undefined,
              operation: 'deadline',
            },
            'Match timer infrastructure failed',
          );
        },
        completions,
      );
      server = createServer({
        logger: { level: config.logLevel },
        auth: {
          policy,
          sessions: new MemorySessionStore(clock, scheduler, () =>
            server?.log.error(
              { code: 'SESSION_TIMER_FAILURE' },
              'Session invalidated after infrastructure failure',
            ),
          ),
          login: new LoginService(players, () => clock.now()),
          registration: new RegistrationService(players, () => clock.now()),
        },
        lobby: { coordinator, players },
        completions,
        history: new HistoryRepository(database),
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
      completions?.reportPending();
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
