import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const baseUrl = process.env.SMOKE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`;
const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { status: 'ok' });

for (const transport of ['polling', 'websocket']) {
  const socket = io(baseUrl, {
    transports: [transport],
    reconnection: false,
    timeout: 5_000,
    autoConnect: false,
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    assert.equal(socket.connected, true);
    console.log(`Socket.IO ${transport}: connected`);
  } finally {
    socket.disconnect();
  }
}
console.log('HTTP health: 200; smoke checks passed');
