import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const fixture = `
  import assert from 'node:assert/strict';
  import { once } from 'node:events';
  import { createServer as createTcpServer } from 'node:net';
  import { io } from 'socket.io-client';
  import { testAuth, fixturePlayer } from './tests/support/auth.ts';
  const auth = testAuth();
  const token = await auth.sessions.create(fixturePlayer);
  import { Server as SocketIOServer } from 'socket.io';
  import { readConfig } from './src/config.ts';
  import { connectPostgres } from './src/persistence/postgres.ts';
  import { createServer } from './src/transport/server.ts';
  import { runBackend } from './src/main.ts';
  const secret = 'credential-marker:@/?#%$';
  const config = { ...readConfig({ DATABASE_URL: 'postgresql://user:password@localhost/db' }), port: 0 };
  // Observe actual Engine.IO cleanup too: its automatic HTTP-close callback
  // otherwise duplicates explicit preClose cleanup, even with no live clients.
  let realtimeCloses = 0;
  const attach = SocketIOServer.prototype.attach;
  SocketIOServer.prototype.attach = function (...args) {
    const attached = attach.apply(this, args);
    const cleanup = this.engine.cleanup.bind(this.engine);
    this.engine.cleanup = () => { realtimeCloses++; cleanup(); };
    return attached;
  };
  const server = createServer({ logger: { level: 'info' }, auth });
  SocketIOServer.prototype.attach = attach;
  const database = connectPostgres(config.database);
  const order = [];
  let listenerCloses = 0;
  const closeListener = server.server.close.bind(server.server);
  server.server.close = (...args) => { listenerCloses++; return closeListener(...args); };
  const closeServer = server.close.bind(server);
  server.close = async () => { order.push('http'); await closeServer(); };
  const endPool = database.end.bind(database);
  database.end = async () => { order.push('pool'); await endPool(); };
  const result = { command: 'SELECT', rowCount: 1, oid: 0, fields: [], rows: [{ '?column?': 1 }] };
  async function signal(name) {
    const handled = once(process, name);
    process.kill(process.pid, name);
    await handled;
  }
  function assertClean() {
    assert.deepEqual(order, ['http', 'pool']);
    assert.equal(listenerCloses, 1);
    assert.equal(realtimeCloses, 1);
    assert.equal(server.server.listening, false);
    assert.equal(database.ended, true);
    assert.equal(process.listenerCount('SIGINT'), 0);
    assert.equal(process.listenerCount('SIGTERM'), 0);
  }
`;

async function scenario(body: string, expectedCode: number) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', fixture + body],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    output += data.toString();
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 8_000);
  try {
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      },
    );
    assert.equal(outcome.signal, null, output);
    assert.equal(outcome.code, expectedCode, output);
    assert.doesNotMatch(output, /credential-marker|postgresql:\/\/|UnhandledPromiseRejection/);
    return output;
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

for (const name of ['SIGINT', 'SIGTERM']) {
  test(
    `${name} during database startup skips HTTP and cleans up once`,
    { timeout: 10_000 },
    async () => {
      await scenario(
        `
      let release;
      database.query = () => new Promise(resolve => { release = () => resolve(result); });
      const running = runBackend(config, server, database);
      await signal('${name}');
      await signal('${name === 'SIGINT' ? 'SIGTERM' : 'SIGINT'}');
      release();
      await running;
      assertClean();
    `,
        0,
      );
    },
  );

  test(
    `${name} during HTTP startup waits for startup then closes once`,
    { timeout: 10_000 },
    async () => {
      await scenario(
        `
      database.query = async () => result;
      let entered, release;
      const entering = new Promise(resolve => { entered = resolve; });
      const barrier = new Promise(resolve => { release = resolve; });
      server.addHook('onReady', async () => { entered(); await barrier; });
      const running = runBackend(config, server, database);
      await entering;
      await signal('${name}');
      release();
      await running;
      assertClean();
    `,
        0,
      );
    },
  );
}

test(
  'normal startup, active sockets, and repeated signals during cleanup exit cleanly',
  { timeout: 10_000 },
  async () => {
    await scenario(
      `
    database.query = async () => result;
    let entered, release;
    const entering = new Promise(resolve => { entered = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    server.addHook('onClose', async () => { entered(); await barrier; });
    const listening = once(server.server, 'listening');
    const running = runBackend(config, server, database);
    await listening;
    const address = 'http://127.0.0.1:' + server.server.address().port;
    assert.equal((await fetch(address + '/health')).status, 200);
    const clients = [];
    for (const transport of ['polling', 'websocket']) {
      const socket = io(address, { extraHeaders: { Origin: 'http://localhost', Cookie: 'trivia_session=' + token }, transports: [transport], reconnection: false, autoConnect: false, timeout: 2000 });
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
      clients.push(socket);
    }
    const disconnected = Promise.all(clients.map(socket => new Promise(resolve => socket.once('disconnect', resolve))));
    await signal('SIGTERM');
    await entering;
    await signal('SIGINT');
    release();
    await running;
    await disconnected;
    for (const client of clients) { assert.equal(client.connected, false); client.disconnect(); }
    assertClean();
  `,
      0,
    );
  },
);

test(
  'startup rejection concurrent with a signal preserves failure and closes only once',
  { timeout: 10_000 },
  async () => {
    const output = await scenario(
      `
    let reject;
    database.query = () => new Promise((_, fail) => { reject = fail; });
    const running = runBackend(config, server, database);
    await signal('SIGINT');
    reject(Object.assign(new Error(secret), { code: 'ECONNREFUSED' }));
    await running;
    assertClean();
  `,
      1,
    );
    assert.match(output, /ECONNREFUSED/);
  },
);

test('HTTP bind failure is nonzero and still ends PostgreSQL', { timeout: 10_000 }, async () => {
  const output = await scenario(
    `
    const occupied = createServer();
    await occupied.listen({ host: '127.0.0.1', port: 0 });
    config.port = occupied.server.address().port;
    database.query = async () => result;
    await runBackend(config, server, database);
    await occupied.close();
    assertClean();
  `,
    1,
  );
  assert.match(output, /EADDRINUSE/);
});

for (const failure of ['HTTP', 'PostgreSQL']) {
  test(
    `${failure} cleanup failure is nonzero, redacted, and does not skip other cleanup`,
    { timeout: 10_000 },
    async () => {
      const output = await scenario(
        `
      database.query = async () => result;
      ${
        failure === 'HTTP'
          ? "server.addHook('onClose', async () => { throw new Error(secret); });"
          : "database.end = async () => { order.push('pool'); await endPool(); throw new Error(secret); };"
      }
      const listening = once(server.server, 'listening');
      const running = runBackend(config, server, database);
      await listening;
      await signal('SIGTERM');
      await running;
      assertClean();
    `,
        1,
      );
      assert.match(output, /cleanup failed/);
    },
  );
}

test(
  'real unreachable PostgreSQL fails startup without listening or leaking resources',
  { timeout: 10_000 },
  async () => {
    const output = await scenario(
      `
    // Use a real refused TCP connection rather than mocking a driver rejection.
    const endpoint = createServer();
    await endpoint.listen({ host: '127.0.0.1', port: 0 });
    const port = endpoint.server.address().port;
    await endpoint.close();
    const pool = connectPostgres({ ...config.database, host: '127.0.0.1', port });
    const end = pool.end.bind(pool);
    pool.end = async () => { order.push('pool'); await end(); };
    await runBackend(config, server, pool);
    assert.deepEqual(order, ['http', 'pool']);
    assert.equal(listenerCloses, 1);
    assert.equal(server.server.listening, false);
    assert.equal(pool.ended, true);
  `,
      1,
    );
    assert.match(output, /ECONNREFUSED/);
  },
);

test(
  'signal during a real PostgreSQL handshake followed by failure stays nonzero',
  { timeout: 10_000 },
  async () => {
    await scenario(
      `
    const endpoint = createTcpServer();
    const startupReceived = new Promise(resolve => endpoint.once('connection', socket => {
      socket.once('data', () => resolve(socket));
    }));
    await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
    database.options.host = '127.0.0.1';
    database.options.port = endpoint.address().port;
    const running = runBackend(config, server, database);
    const socket = await startupReceived;
    await signal('SIGTERM');
    socket.destroy();
    await running;
    await new Promise(resolve => endpoint.close(resolve));
    assertClean();
  `,
      1,
    );
  },
);
