import Fastify from 'fastify';
import { Server } from 'socket.io';

export function createServer({ logger = false }: { logger?: boolean | { level: string } } = {}) {
  const http = Fastify({ logger, return503OnClosing: true });
  const realtime = new Server(http.server, { serveClient: false });

  // Liveness only: no gameplay, identity, or database facts are exposed.
  http.get('/health', async () => ({ status: 'ok' }));

  // Upgraded sockets must close before Fastify drains its shared HTTP server.
  http.addHook('preClose', async () => {
    realtime.engine.close();
  });
  http.addHook('onClose', async () => {
    await realtime.close();
  });

  return http;
}
