import Fastify, { LogController } from 'fastify';
import type { Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from 'socket.io';
import { installAuthentication } from './authentication.js';
import type { Authentication } from './authentication.js';
import { allowedOrigin, secureRequest } from './auth-policy.js';
import { installLobbyGateway } from './lobby-gateway.js';
import type { LobbyRuntime } from './lobby-gateway.js';
import type { MatchCompletions } from '../application/match-completions.js';
import type { HistoryReader } from '../application/history.js';
import { installHistory } from './history.js';

export function createServer({
  logger = false,
  auth,
  lobby,
  completions,
  history,
}: {
  logger?: boolean | { level: string; stream?: Writable };
  auth?: Authentication;
  lobby?: LobbyRuntime;
  completions?: MatchCompletions;
  history?: HistoryReader;
} = {}) {
  if (lobby && !auth) throw new TypeError('Lobby requires authentication');
  if (history && !auth) throw new TypeError('History requires authentication');
  const http = Fastify({
    logger: logger
      ? {
          ...(typeof logger === 'object' ? logger : {}),
          redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
        }
      : false,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: auth?.policy.trustProxy ?? false,
    return503OnClosing: true,
  });
  const existingCloseListeners = new Set(http.server.listeners('close'));
  const realtime = new Server(http.server, {
    serveClient: false,
    cors: {
      origin: (value, callback) => callback(null, !!auth && allowedOrigin(auth.policy, value)),
      credentials: true,
      allowedHeaders: ['Content-Type'],
    },
    allowRequest: (request, callback) =>
      callback(
        null,
        !!auth &&
          allowedOrigin(auth.policy, request.headers.origin) &&
          secureRequest(auth.policy, request),
      ),
  });
  // Engine.IO middleware also covers subsequent polling/upgrade requests, where
  // allowRequest alone only protects initial connection establishment.
  realtime.engine.use(
    (request: IncomingMessage, _response: ServerResponse, next: (error?: Error) => void) => {
      if (
        !auth ||
        !allowedOrigin(auth.policy, request.headers.origin) ||
        !secureRequest(auth.policy, request)
      )
        return next(new Error('ORIGIN_FORBIDDEN'));
      next();
    },
  );
  http.setErrorHandler((error, request, reply) => {
    const code =
      error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : 500;
    const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 500;
    if (status === 500) request.log.error({ code: 'HTTP_INTERNAL_FAILURE' }, 'HTTP request failed');
    reply.code(status).send({
      code:
        status === 413
          ? 'PAYLOAD_TOO_LARGE'
          : status === 500
            ? 'INTERNAL_ERROR'
            : 'INVALID_REQUEST',
    });
  });
  if (auth) installAuthentication(http, realtime, auth);
  else realtime.use((_socket, next) => next(new Error('UNAUTHENTICATED')));
  if (auth && history) installHistory(http, auth, history);
  const closeLobby =
    auth && lobby
      ? installLobbyGateway(realtime, auth, lobby, (code, matchId) =>
          http.log.error({ code, matchId }, 'Lobby operation unavailable'),
        )
      : undefined;
  // Engine.IO installs automatic HTTP-close cleanup. Move those exact callbacks
  // to preClose: upgraded sockets must close before HTTP drain, not again after it.
  const realtimeCloseListeners = http.server
    .listeners('close')
    .filter((listener) => !existingCloseListeners.has(listener)) as Array<() => void>;
  for (const listener of realtimeCloseListeners) http.server.off('close', listener);

  // Liveness only: no gameplay, identity, or database facts are exposed.
  http.get('/health', async () => ({ status: 'ok' }));

  // Upgraded sockets must close before Fastify drains its shared HTTP server.
  http.addHook('preClose', async () => {
    closeLobby?.();
    try {
      await lobby?.coordinator.shutdown();
      await completions?.close();
    } finally {
      auth?.login.close();
      try {
        await auth?.sessions.close();
      } finally {
        for (const listener of realtimeCloseListeners) listener.call(http.server);
      }
    }
  });
  http.addHook('onClose', async () => {
    // Fastify owns the HTTP listener. Socket.IO.close() would close it (and
    // Engine.IO) again. The skeleton uses only the default namespace/adapter.
    await realtime.sockets.adapter.close();
  });

  return http;
}
