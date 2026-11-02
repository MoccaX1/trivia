import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const baseUrl = process.env.SMOKE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`;
const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { status: 'ok' });

const origin = process.env.SMOKE_ORIGIN ?? process.env.AUTH_PUBLIC_ORIGIN;
assert.ok(origin, 'SMOKE_ORIGIN or AUTH_PUBLIC_ORIGIN is required');
let cookie;
if (process.env.SMOKE_USERNAME && process.env.SMOKE_PASSWORD) {
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.SMOKE_USERNAME,
      password: process.env.SMOKE_PASSWORD,
    }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
}
for (const transport of ['polling', 'websocket']) {
  const socket = io(baseUrl, {
    extraHeaders: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    transports: [transport],
    reconnection: false,
    timeout: 5_000,
    autoConnect: false,
  });
  try {
    const connected = new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    if (cookie) {
      await connected;
      assert.equal(socket.connected, true);
    } else {
      await assert.rejects(connected);
      assert.equal(socket.connected, false);
    }
    console.log(
      `Socket.IO ${transport}: ${cookie ? 'authenticated' : 'unauthenticated connection rejected'}`,
    );
  } finally {
    socket.disconnect();
  }
}
console.log('HTTP health: 200; smoke checks passed');
