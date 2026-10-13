import Fastify from 'fastify';
import { Server } from 'socket.io';

export function createServer({ logger = false }: { logger?: boolean | { level: string } } = {}) {
  const http = Fastify({ logger, return503OnClosing: true });
  const existingCloseListeners = new Set(http.server.listeners('close'));
  const realtime = new Server(http.server, { serveClient: false });
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
    for (const listener of realtimeCloseListeners) listener.call(http.server);
  });
  http.addHook('onClose', async () => {
    // Fastify owns the HTTP listener. Socket.IO.close() would close it (and
    // Engine.IO) again. The skeleton uses only the default namespace/adapter.
    await realtime.sockets.adapter.close();
  });

  return http;
}
