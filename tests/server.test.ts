import assert from 'node:assert/strict';
import test from 'node:test';
import { io } from 'socket.io-client';
import { createServer } from '../src/transport/server.js';

test(
  'HTTP health uses a real listener and releases it on close',
  { timeout: 10_000 },
  async (t) => {
    const server = createServer();
    t.after(() => server.close());
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    await server.close();
    assert.equal(server.server.listening, false);
    await assert.rejects(fetch(`${address}/health`, { signal: AbortSignal.timeout(1_000) }));
  },
);

for (const transport of ['polling', 'websocket']) {
  test(
    `Socket.IO ${transport} shares HTTP port and disconnects on shutdown`,
    { timeout: 10_000 },
    async (t) => {
      const server = createServer();
      t.after(() => server.close());
      const address = await server.listen({ host: '127.0.0.1', port: 0 });
      const socket = io(address, {
        transports: [transport],
        reconnection: false,
        timeout: 2_000,
        autoConnect: false,
      });
      t.after(() => socket.disconnect());
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
        socket.connect();
      });
      assert.equal(socket.connected, true);
      assert.equal((await fetch(`${address}/health`)).status, 200);

      const disconnected = new Promise<void>((resolve) => {
        socket.once('disconnect', () => resolve());
      });
      await server.close();
      await disconnected;
      assert.equal(socket.connected, false);
      assert.equal(server.server.listening, false);
    },
  );
}
