import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import { HistoryError, historyPage, isHistoryUuid } from '../application/history.js';
import type { HistoryReader } from '../application/history.js';
import type { Authentication } from './authentication.js';
import { allowedOrigin, secureRequest, sessionToken } from './auth-policy.js';

export function installHistory(
  http: FastifyInstance,
  auth: Authentication,
  history: HistoryReader,
): void {
  const protect: onRequestAsyncHookHandler = async (request, reply) => {
    reply.header('cache-control', 'no-store').header('vary', 'Origin');
    const origin = request.headers.origin;
    if (
      !secureRequest(auth.policy, request.raw) ||
      (origin !== undefined && !allowedOrigin(auth.policy, origin))
    )
      return reply.code(403).send({ code: 'ORIGIN_FORBIDDEN' });
    if (origin !== undefined)
      reply
        .header('access-control-allow-origin', new URL(origin).origin)
        .header('access-control-allow-credentials', 'true');
    if (request.method === 'OPTIONS') {
      if (
        origin === undefined ||
        !allowedOrigin(auth.policy, origin) ||
        request.headers['access-control-request-method'] !== 'GET' ||
        (request.headers['access-control-request-headers'] ?? '')
          .split(',')
          .some((h) => h.trim() && h.trim().toLowerCase() !== 'content-type')
      )
        return reply.code(403).send({ code: 'ORIGIN_FORBIDDEN' });
      return reply
        .header('access-control-allow-methods', 'GET')
        .header('access-control-allow-headers', 'Content-Type')
        .code(204)
        .send();
    }
    if (!(await auth.sessions.resolve(sessionToken(request.headers.cookie, auth.policy))))
      return reply.code(401).send({ code: 'UNAUTHENTICATED' });
  };
  for (const path of ['/history', '/history/:matchId']) {
    http.options(path, { onRequest: protect }, async (_request, reply) => reply.code(204).send());
    http.get(path, { onRequest: protect }, async (request, reply) => {
      const token = sessionToken(request.headers.cookie, auth.policy);
      const player = await auth.sessions.resolve(token);
      if (!player) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      let operation: () =>
        | ReturnType<HistoryReader['listForPlayer']>
        | ReturnType<HistoryReader['findDetailForPlayer']>;
      try {
        if (path === '/history') {
          const page = historyPage(request.query);
          operation = () => history.listForPlayer(player.id, page);
        } else {
          const { matchId } = request.params as { matchId: unknown };
          if (!isHistoryUuid(matchId) || Object.keys(request.query as object).length !== 0)
            return reply.code(400).send({ code: 'INVALID_REQUEST' });
          operation = () => history.findDetailForPlayer(player.id, matchId);
        }
      } catch {
        return reply.code(400).send({ code: 'INVALID_REQUEST' });
      }
      try {
        const data = await operation();
        const sent = await auth.sessions.inspect(token, () =>
          data === null ? reply.code(404).send({ code: 'NOT_FOUND' }) : reply.send(data),
        );
        if (!sent) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        return reply;
      } catch (error) {
        const unavailable = error instanceof HistoryError && error.code === 'HISTORY_UNAVAILABLE';
        request.log.error(
          {
            code: unavailable ? 'HISTORY_UNAVAILABLE' : 'HISTORY_INTEGRITY_FAILURE',
            operation: path === '/history' ? 'history-list' : 'history-detail',
          },
          'History read unavailable',
        );
        const sent = await auth.sessions.inspect(token, () =>
          reply
            .code(unavailable ? 503 : 500)
            .send({ code: unavailable ? 'HISTORY_UNAVAILABLE' : 'INTERNAL_ERROR' }),
        );
        if (!sent) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        return reply;
      }
    });
  }
}
