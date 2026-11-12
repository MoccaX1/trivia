import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import type { Server } from 'socket.io';
import type { SessionStore } from '../application/sessions.js';
import type { RegistrationService } from '../application/registration.js';
import { PlayerPersistenceError } from '../persistence/players.js';
import type { LoginService } from '../application/login.js';
import { canonicalUsername } from '../application/player-identity.js';
import { allowedOrigin, secureRequest, sessionCookie, sessionToken } from './auth-policy.js';
import type { AuthPolicy } from './auth-policy.js';

export interface Authentication {
  policy: AuthPolicy;
  sessions: SessionStore;
  login: LoginService;
  registration?: RegistrationService;
}
export function installAuthentication(
  http: FastifyInstance,
  io: Server,
  auth: Authentication,
): void {
  const { policy, sessions, login, registration } = auth;
  // Route-level onRequest runs after routing and before parsing. Use Fastify's
  // registered route identity, so encoded spellings receive identical protection.
  const protectAuthRoute: onRequestAsyncHookHandler = async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!secureRequest(policy, request.raw))
      return reply.code(403).send({ code: 'ORIGIN_FORBIDDEN' });
    // Only this read-only endpoint permits absent Origin; present values still
    // require exact allowlist validation. It never refreshes session activity.
    const safeProfile = request.method === 'GET' && request.routeOptions.url === '/auth/profile';
    const origin = request.headers.origin;
    if (!(safeProfile && origin === undefined) && !allowedOrigin(policy, origin))
      return reply.code(403).send({ code: 'ORIGIN_FORBIDDEN' });
    reply.header('vary', 'Origin');
    if (origin !== undefined)
      reply
        .header('access-control-allow-origin', new URL(origin).origin)
        .header('access-control-allow-credentials', 'true');
    if (request.method === 'OPTIONS') {
      if (
        !['POST', 'GET'].includes(request.headers['access-control-request-method'] ?? '') ||
        (request.headers['access-control-request-headers'] ?? '')
          .split(',')
          .some((value) => value.trim() && value.trim().toLowerCase() !== 'content-type')
      )
        return reply.code(403).send({ code: 'ORIGIN_FORBIDDEN' });
      return reply
        .header('access-control-allow-methods', 'GET, POST')
        .header('access-control-allow-headers', 'Content-Type')
        .code(204)
        .send();
    }
    if (request.method === 'POST' && request.routeOptions.url === '/auth/register') {
      const admission = registration?.admitIp(request.ip);
      if (!registration || admission)
        return reply
          .code(admission?.status === 'rate_limited' ? 429 : 503)
          .header('retry-after', admission?.retryAfter ?? 1)
          .send({
            code: admission?.status === 'rate_limited' ? 'RATE_LIMITED' : 'AUTH_UNAVAILABLE',
          });
    }
    if (request.method === 'POST' && request.routeOptions.url === '/auth/login') {
      const admission = login.admitIp(request.ip);
      if (admission)
        return reply
          .code(admission.status === 'rate_limited' ? 429 : 503)
          .header('retry-after', admission.status === 'rate_limited' ? '900' : '1')
          .send({
            code: admission.status === 'rate_limited' ? 'RATE_LIMITED' : 'AUTH_UNAVAILABLE',
          });
    }
    if (
      request.method === 'POST' &&
      request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json'
    )
      return reply.code(415).send({ code: 'INVALID_REQUEST' });
  };
  http.options('/auth/*', { onRequest: protectAuthRoute }, async (_request, reply) =>
    reply.code(204).send(),
  );
  http.post(
    '/auth/login',
    { onRequest: protectAuthRoute, bodyLimit: 4096 },
    async (request, reply) => {
      const body = request.body;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        !('username' in body) ||
        !('password' in body) ||
        typeof body.username !== 'string' ||
        typeof body.password !== 'string' ||
        Buffer.byteLength(body.password) < 1 ||
        Buffer.byteLength(body.password) > 1024
      )
        return reply.code(400).send({ code: 'INVALID_REQUEST' });
      let username: string;
      try {
        username = canonicalUsername(body.username);
      } catch {
        return reply.code(400).send({ code: 'INVALID_REQUEST' });
      }
      try {
        const result = await login.login(request.ip, username, body.password, true);
        if (result.status === 'rate_limited')
          return reply.code(429).header('retry-after', '900').send({ code: 'RATE_LIMITED' });
        if (result.status === 'busy')
          return reply.code(503).header('retry-after', '1').send({ code: 'AUTH_UNAVAILABLE' });
        if (result.status === 'invalid_credentials')
          return reply.code(401).send({ code: 'INVALID_CREDENTIALS' });
        if (result.status !== 'authenticated') throw new Error('Invalid authentication result');
        const token = await sessions.create(result.player);
        return reply
          .header('set-cookie', sessionCookie(policy, token))
          .send({ player: { id: result.player.id, displayName: result.player.displayName } });
      } catch {
        request.log.error({ code: 'AUTH_INFRASTRUCTURE_FAILURE' }, 'Authentication unavailable');
        return reply.code(503).header('retry-after', '1').send({ code: 'AUTH_UNAVAILABLE' });
      }
    },
  );
  http.post(
    '/auth/register',
    { onRequest: protectAuthRoute, bodyLimit: 4096 },
    async (request, reply) => {
      if (!registration)
        return reply.code(503).header('retry-after', '1').send({ code: 'AUTH_UNAVAILABLE' });
      const controller = new AbortController();
      const abort = () => controller.abort();
      const disconnect = () => {
        if (!reply.raw.writableFinished) abort();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', disconnect);
      try {
        const result = await registration.register(request.body, controller.signal);
        if (result.status === 'invalid') return reply.code(400).send({ code: 'INVALID_REQUEST' });
        if (result.status === 'busy')
          return reply.code(503).header('retry-after', '1').send({ code: 'AUTH_UNAVAILABLE' });
        if (result.status === 'created') return reply.code(201).send({ player: result.player });
      } catch (error) {
        if (error instanceof PlayerPersistenceError) {
          if (error.code === 'USERNAME_TAKEN')
            return reply.code(409).send({ code: 'USERNAME_TAKEN' });
          request.log.error({ code: 'REGISTRATION_STORAGE_FAILURE' }, 'Registration unavailable');
          return reply.code(503).header('retry-after', '1').send({ code: 'AUTH_UNAVAILABLE' });
        }
        request.log.error({ code: 'REGISTRATION_INTERNAL_FAILURE' }, 'Registration unavailable');
        return reply.code(500).send({ code: 'INTERNAL_ERROR' });
      } finally {
        request.raw.off('aborted', abort);
        reply.raw.off('close', disconnect);
      }
    },
  );
  http.get('/auth/profile', { onRequest: protectAuthRoute }, async (request, reply) => {
    const player = await sessions.resolve(sessionToken(request.headers.cookie, policy));
    if (!player) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    return { player: { id: player.id, displayName: player.displayName } };
  });
  http.post('/auth/logout', { onRequest: protectAuthRoute }, async (request, reply) => {
    const token = sessionToken(request.headers.cookie, policy);
    if (!(await sessions.resolve(token))) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    await sessions.revoke(token);
    return reply.header('set-cookie', sessionCookie(policy, '')).code(204).send();
  });
  io.use(async (socket, next) => {
    try {
      const token = sessionToken(socket.request.headers.cookie, policy);
      const player = await sessions.resolve(token);
      if (!player) return next(new Error('UNAUTHENTICATED'));
      // Trusted context only. Handshake auth/query identity fields are ignored.
      socket.data.player = Object.freeze({ id: player.id, displayName: player.displayName });
      const unwatch = await sessions.watch(token, () => socket.conn.close(true));
      if (!unwatch) return next(new Error('UNAUTHENTICATED'));
      socket.once('disconnect', unwatch);
      // Middleware may fail before connection: also release the association on Engine.IO close.
      socket.conn.once('close', unwatch);
      if (!(await sessions.resolve(token))) {
        unwatch();
        return next(new Error('UNAUTHENTICATED'));
      }
      next();
    } catch {
      http.log.error(
        { code: 'SESSION_INFRASTRUCTURE_FAILURE' },
        'Socket authentication unavailable',
      );
      next(new Error('AUTH_UNAVAILABLE'));
    }
  });
}
