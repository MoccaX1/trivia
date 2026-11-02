import type { FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import type { SessionStore } from '../application/sessions.js';
import type { LoginService } from '../application/login.js';
import { canonicalUsername } from '../application/player-identity.js';
import { allowedOrigin, secureRequest, sessionCookie, sessionToken } from './auth-policy.js';
import type { AuthPolicy } from './auth-policy.js';

export interface Authentication {
  policy: AuthPolicy;
  sessions: SessionStore;
  login: LoginService;
}
export function installAuthentication(
  http: FastifyInstance,
  io: Server,
  auth: Authentication,
): void {
  const { policy, sessions, login } = auth;
  http.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/auth/')) return;
    reply.header('cache-control', 'no-store');
    if (!secureRequest(policy, request.raw))
      return reply.code(403).send({ code: 'ORIGIN_FORBIDDEN' });
    // Only this read-only endpoint permits absent Origin; present values still
    // require exact allowlist validation. It never refreshes session activity.
    const safeProfile = request.method === 'GET' && request.url.split('?')[0] === '/auth/profile';
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
    if (request.method === 'POST' && request.url.split('?')[0] === '/auth/login') {
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
  });
  http.options('/auth/*', async (_request, reply) => reply.code(204).send());
  http.post('/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
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
  });
  http.get('/auth/profile', async (request, reply) => {
    const player = await sessions.resolve(sessionToken(request.headers.cookie, policy));
    if (!player) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    return { player: { id: player.id, displayName: player.displayName } };
  });
  http.post('/auth/logout', async (request, reply) => {
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
