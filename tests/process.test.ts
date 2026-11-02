import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

test(
  'transport shutdown leaves no resources keeping the process alive',
  { timeout: 10_000 },
  async () => {
    // A child must exit naturally; an explicit process.exit would hide leaked timers.
    await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `
    import { io } from 'socket.io-client';
    import { testAuth, fixturePlayer } from './tests/support/auth.ts';
    import { createServer } from './src/transport/server.ts';
    for (const transport of ['polling', 'websocket']) {
      const auth = testAuth();
      const token = await auth.sessions.create(fixturePlayer);
      const server = createServer({ auth });
      const address = await server.listen({ host: '127.0.0.1', port: 0 });
      const socket = io(address, {
        extraHeaders: { Origin: 'http://localhost', Cookie: 'trivia_session=' + token },
        transports: [transport], reconnection: false, timeout: 2000, autoConnect: false,
      });
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
        socket.connect();
      });
      await fetch(address + '/health');
      const disconnected = new Promise(resolve => socket.once('disconnect', resolve));
      await server.close();
      await disconnected;
      socket.disconnect();
    }
  `,
      ],
      { timeout: 5_000 },
    );
  },
);
