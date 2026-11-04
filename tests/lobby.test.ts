import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import pg from 'pg';
import { createServer } from '../src/transport/server.js';
import type { LobbyAcknowledgement } from '../src/transport/lobby-gateway.js';
import { presentLobby } from '../src/application/lobby-presenter.js';
import type { LobbySnapshot } from '../src/application/lobby-presenter.js';
import { createMatch, startMatch } from '../src/domain/match-engine.js';
import { MatchCoordinator } from '../src/application/match-coordinator.js';
import { LoginService } from '../src/application/login.js';
import { MemorySessionStore, idleMs } from '../src/application/sessions.js';
import { provisionPlayer } from '../src/application/authenticate-player.js';
import type { PlayerProfile, PlayerCredentials } from '../src/application/authenticate-player.js';
import { verifyPassword } from '../src/application/password.js';
import { readAuthPolicy } from '../src/transport/auth-policy.js';
import { readConfig } from '../src/config.js';
import { connectPostgres } from '../src/persistence/postgres.js';
import { applyMigrations } from '../src/persistence/migrations.js';
import { PlayerRepository } from '../src/persistence/players.js';

const origin = 'http://localhost';
const headers = { origin, 'content-type': 'application/json' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Client = {
  socket: Socket;
  cookie: string;
  token: string;
  player: PlayerProfile;
  snapshots: LobbySnapshot[];
};
function command(
  client: Client,
  event: string,
  payload: object,
  commandId = randomUUID(),
): Promise<LobbyAcknowledgement> {
  return client.socket.timeout(2_000).emitWithAck(event, { commandId, payload });
}
async function accepted(operation: Promise<LobbyAcknowledgement>) {
  const ack = await operation;
  assert.ok(ack.status === 'accepted', JSON.stringify(ack));
  return ack;
}
function snapshot(client: Client, matchId: string, version: number): Promise<LobbySnapshot> {
  const existing = client.snapshots.find(
    (item) => item.matchId === matchId && item.version === version,
  );
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const listener = (item: LobbySnapshot) => {
      if (item.matchId === matchId && item.version === version) {
        client.socket.off('LobbySnapshot', listener);
        resolve(item);
      }
    };
    client.socket.on('LobbySnapshot', listener);
  });
}
// An ACK on this same connection is a transport-order barrier for negative event assertions.
async function barrier(client: Client) {
  const ack: LobbyAcknowledgement = await client.socket.timeout(2_000).emitWithAck('JoinMatch', {});
  assert.equal(ack.status, 'error');
}

async function fixture(t: TestContext, repository?: PlayerRepository) {
  let now = 0;
  const tasks = new Set<{ at: number; callback: (error?: unknown) => void }>();
  const clock = { now: () => now };
  const scheduler = {
    schedule(at: number, callback: (error?: unknown) => void) {
      const task = { at, callback };
      tasks.add(task);
      return () => {
        tasks.delete(task);
      };
    },
  };
  const accounts = new Map<string, PlayerProfile>();
  const add = (name: string) => {
    const player = { id: randomUUID(), displayName: `Trusted ${name}` };
    accounts.set(name, player);
    return player;
  };
  for (const name of ['alice', 'bob', 'carol']) add(name);
  const credentials: Pick<PlayerCredentials, 'findCredentialByUsername'> = repository ?? {
    findCredentialByUsername: async (name) => {
      const player = accounts.get(name);
      return player ? { player, passwordHash: 'fixture-hash' } : null;
    },
  };
  const sessions = new MemorySessionStore(clock, scheduler);
  const auth = {
    policy: readAuthPolicy({
      AUTH_COOKIE_MODE: 'loopback',
      AUTH_PUBLIC_ORIGIN: origin,
      AUTH_ORIGINS: origin,
    }),
    sessions,
    login: new LoginService(
      credentials,
      () => now,
      repository ? verifyPassword : async (_hash, password) => password === 'fixture-password',
    ),
  };
  let readProfile = repository
    ? (id: string) => repository.findPlayerById(id)
    : async (id: string) => [...accounts.values()].find((player) => player.id === id) ?? null;
  const coordinator = new MatchCoordinator(clock, scheduler, randomUUID);
  let logs = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logs += chunk.toString();
      done();
    },
  });
  const server = createServer({
    logger: { level: 'error', stream },
    auth,
    lobby: { coordinator, players: { findPlayerById: (id) => readProfile(id) } },
  });
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) client.socket.disconnect();
    await server.close();
  });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  async function connect(name: string, transport = 'websocket', existingCookie?: string) {
    const login = await server.inject({
      method: 'POST',
      url: '/auth/login',
      headers,
      payload: { username: name, password: 'fixture-password' },
    });
    assert.equal(login.statusCode, 200);
    const cookie = existingCookie ?? (login.headers['set-cookie'] as string).split(';')[0]!;
    const socket = io(address, {
      transports: [transport],
      extraHeaders: { Origin: origin, Cookie: cookie },
      auth: { playerId: 'spoof', displayName: 'spoof' },
      reconnection: false,
      autoConnect: false,
    });
    const client = {
      socket,
      cookie,
      token: cookie.split('=')[1]!,
      player: login.json().player as PlayerProfile,
      snapshots: [] as LobbySnapshot[],
    };
    clients.push(client);
    socket.on('LobbySnapshot', (item) => client.snapshots.push(item));
    const connected = new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    socket.connect();
    await connected;
    return client;
  }
  return {
    auth,
    coordinator,
    server,
    connect,
    accounts,
    add,
    tasks,
    setTime: (time: number) => {
      now = time;
    },
    lookup: (reader: typeof readProfile) => {
      readProfile = reader;
    },
    logs: () => logs,
  };
}

for (const transport of ['polling', 'websocket']) {
  test(
    `${transport}: authenticated create/join/leave delivers only safe subscribed WAITING snapshots`,
    { timeout: 8_000 },
    async (t) => {
      const f = await fixture(t);
      const a = await f.connect('alice', transport),
        b = await f.connect('bob', transport);
      const otherSession = await f.connect('alice', transport);
      const otherSocket = await f.connect('alice', transport, a.cookie);
      const created = await accepted(command(a, 'CreateMatch', {}));
      const initial = await snapshot(a, created.matchId, 1);
      assert.deepEqual(initial, {
        matchId: created.matchId,
        version: 1,
        phase: 'WAITING',
        state: {
          hostPlayerId: a.player.id,
          participants: [{ playerId: a.player.id, displayName: 'Trusted alice' }],
          rules: {
            questionCount: 10,
            answerWindowMs: 10_000,
            revealDurationMs: 5_000,
            allowAnswerChanges: true,
            maxAttempts: 3,
            earlyClose: false,
          },
        },
      });
      const joined = await accepted(command(b, 'JoinMatch', { matchId: created.matchId }));
      assert.equal(joined.version, 2);
      const joinedSnapshot = await snapshot(a, created.matchId, 2);
      assert.deepEqual(await snapshot(b, created.matchId, 2), joinedSnapshot);
      assert.deepEqual(
        joinedSnapshot.state.participants.map((p) => p.playerId),
        [a.player.id, b.player.id],
      );
      const left = await accepted(command(b, 'LeaveMatch', { matchId: created.matchId }));
      assert.equal(left.version, 3);
      assert.deepEqual(
        (await snapshot(a, created.matchId, 3)).state.participants,
        initial.state.participants,
      );
      await barrier(b);
      await barrier(otherSession);
      await barrier(otherSocket);
      assert.deepEqual(
        b.snapshots.map((item) => item.version),
        [2],
      );
      assert.deepEqual(otherSession.snapshots, []);
      assert.deepEqual(otherSocket.snapshots, []);
      assert.doesNotMatch(
        JSON.stringify(a.snapshots),
        /correctChoice|private|password|token|receiptSequence|receivedAt/,
      );
    },
  );
}

test(
  'replayed and in-flight commands retain historical ACKs without socket effects or old broadcasts',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice'),
      b = await f.connect('bob');
    const createId = randomUUID();
    const created = await accepted(command(a, 'CreateMatch', {}, createId));
    await snapshot(a, created.matchId, 1);
    const joinId = randomUUID();
    const [first, retry] = await Promise.all([
      command(b, 'JoinMatch', { matchId: created.matchId }, joinId),
      command(b, 'JoinMatch', { matchId: created.matchId }, joinId),
    ]);
    assert.deepEqual(first, retry);
    await snapshot(b, created.matchId, 2);
    const leaveId = randomUUID();
    const left = await accepted(command(b, 'LeaveMatch', { matchId: created.matchId }, leaveId));
    await snapshot(a, created.matchId, 3);
    assert.deepEqual(await command(b, 'JoinMatch', { matchId: created.matchId }, joinId), first);
    assert.deepEqual(await command(a, 'CreateMatch', {}, createId), created);
    await barrier(b);
    assert.deepEqual(
      b.snapshots.map((item) => item.version),
      [2],
    );
    const rejoined = await accepted(command(b, 'JoinMatch', { matchId: created.matchId }));
    await snapshot(b, created.matchId, rejoined.version);
    assert.deepEqual(await command(b, 'LeaveMatch', { matchId: created.matchId }, leaveId), left);
    await accepted(command(await f.connect('carol'), 'JoinMatch', { matchId: created.matchId }));
    await snapshot(b, created.matchId, 5); // Old Leave replay did not remove the newer subscription.
    assert.deepEqual(
      a.snapshots.map((item) => item.version),
      [1, 2, 3, 4, 5],
    );
  },
);

test(
  'missing ACK is an unknown outcome; retries do not create or subscribe again, including reconnect',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice');
    const id = randomUUID();
    const delivered = new Promise<LobbySnapshot>((resolve) =>
      a.socket.once('LobbySnapshot', resolve),
    );
    a.socket.emit('CreateMatch', { commandId: id, payload: {} }); // Simulated lost ACK, not a rejected command.
    const first = await delivered;
    const replay = await accepted(command(a, 'CreateMatch', {}, id));
    assert.equal(replay.matchId, first.matchId);
    assert.equal(replay.version, 1);
    a.socket.disconnect();
    const reconnect = await f.connect('alice', 'websocket', a.cookie);
    assert.deepEqual(await command(reconnect, 'CreateMatch', {}, id), replay);
    await accepted(command(await f.connect('bob'), 'JoinMatch', { matchId: first.matchId }));
    await barrier(reconnect);
    assert.deepEqual(reconnect.snapshots, []);
  },
);

test(
  'spoofed fields, malformed envelopes, unknown Matches and Host leave have safe distinct outcomes',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice');
    for (const value of [
      {},
      { commandId: 'x', payload: { playerId: randomUUID() } },
      { commandId: 'x', payload: {}, displayName: 'spoof' },
    ]) {
      const ack: LobbyAcknowledgement = await a.socket
        .timeout(2_000)
        .emitWithAck('CreateMatch', value);
      assert.ok(ack.status === 'error');
      assert.equal(ack.error.code, 'INVALID_REQUEST');
    }
    const missing = await command(a, 'JoinMatch', { matchId: 'unknown' });
    assert.ok(missing.status === 'rejected');
    assert.equal(missing.error.code, 'MATCH_NOT_FOUND');
    const created = await accepted(command(a, 'CreateMatch', {}));
    const hostLeave = await command(a, 'LeaveMatch', { matchId: created.matchId });
    assert.ok(hostLeave.status === 'rejected');
    assert.equal(hostLeave.error.code, 'HOST_DEPARTURE_DEFERRED');
    assert.equal(hostLeave.version, 1);
  },
);

test(
  'concurrent sockets obey actual admission FIFO and the ten-player boundary',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice');
    const { matchId } = await accepted(command(a, 'CreateMatch', {}));
    const clients = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const name = `guest${i}`;
        f.add(name);
        return f.connect(name);
      }),
    );
    const admitted: string[] = [];
    const dispatch = f.coordinator.dispatch.bind(f.coordinator);
    f.coordinator.dispatch = (player, id, input) => {
      admitted.push(id);
      return dispatch(player, id, input);
    };
    const outcomes = await Promise.all(
      clients.map((client) => command(client, 'JoinMatch', { matchId })),
    );
    const byId = new Map(outcomes.map((ack) => [ack.commandId, ack]));
    assert.deepEqual(
      admitted.slice(0, 9).map((id) => byId.get(id)?.status),
      Array(9).fill('accepted'),
    );
    assert.deepEqual(
      admitted.slice(0, 9).map((id) => {
        const ack = byId.get(id)!;
        return 'version' in ack ? ack.version : null;
      }),
      [2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    const last = byId.get(admitted[9]!)!;
    assert.ok(last.status === 'rejected');
    assert.equal(last.error.code, 'MATCH_FULL');
    assert.equal((await snapshot(a, matchId, 10)).state.participants.length, 10);
  },
);

test(
  'profile lookup failure preserves accepted outcome; a later valid event projects trusted names',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice');
    const failed = deferred();
    f.lookup(async () => {
      failed.resolve();
      throw new Error('SECRET_DATABASE_DETAILS');
    });
    const created = await accepted(command(a, 'CreateMatch', {}));
    await failed.promise;
    await barrier(a);
    assert.deepEqual(a.snapshots, []);
    assert.match(f.logs(), /LOBBY_PROFILE_FAILURE/);
    assert.doesNotMatch(f.logs(), /SECRET_DATABASE_DETAILS/);
    f.lookup(async (id) => [...f.accounts.values()].find((p) => p.id === id) ?? null);
    await command(a, 'LeaveMatch', { matchId: created.matchId }); // Host rejection still permits fresh projection.
    await snapshot(a, created.matchId, 1);
    assert.equal(f.coordinator.lookup(created.matchId).status, 'found');
  },
);

test(
  'delayed enrichment regenerates latest state and cannot deliver to a player who left',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice'),
      b = await f.connect('bob');
    const { matchId } = await accepted(command(a, 'CreateMatch', {}));
    await snapshot(a, matchId, 1);
    const started = deferred(),
      release = deferred();
    f.lookup(async (id) => {
      started.resolve();
      await release.promise;
      return [...f.accounts.values()].find((p) => p.id === id) ?? null;
    });
    await accepted(command(b, 'JoinMatch', { matchId }));
    await started.promise;
    // Finish a newer projection before allowing the old reads to complete.
    f.lookup(async (id) => [...f.accounts.values()].find((p) => p.id === id) ?? null);
    await accepted(command(b, 'LeaveMatch', { matchId }));
    await snapshot(a, matchId, 3);
    release.resolve();
    await barrier(b);
    assert.deepEqual(
      a.snapshots.map((item) => item.version),
      [1, 3],
    );
    assert.deepEqual(b.snapshots, []);
  },
);

test(
  'revocation during enrichment disconnects only that session and never delivers its pending snapshot',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice'),
      b = await f.connect('bob'),
      other = await f.connect('bob');
    const { matchId } = await accepted(command(a, 'CreateMatch', {}));
    await snapshot(a, matchId, 1);
    const started = deferred(),
      release = deferred();
    f.lookup(async (id) => {
      started.resolve();
      await release.promise;
      return [...f.accounts.values()].find((p) => p.id === id) ?? null;
    });
    await accepted(command(b, 'JoinMatch', { matchId }));
    await started.promise;
    const gone = new Promise<void>((resolve) => b.socket.once('disconnect', () => resolve()));
    assert.equal(
      (
        await f.server.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: { ...headers, cookie: b.cookie },
          payload: {},
        })
      ).statusCode,
      204,
    );
    await gone;
    release.resolve();
    await snapshot(a, matchId, 2);
    await barrier(other);
    assert.deepEqual(b.snapshots, []);
    assert.equal(other.socket.connected, true);
    assert.deepEqual(other.snapshots, []);
  },
);

test(
  'expiry is enforced at admission even before its timer executes; already-admitted work survives revocation',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice');
    let calls = 0;
    const original = f.coordinator.create.bind(f.coordinator);
    f.coordinator.create = (player, id) => {
      calls++;
      return original(player, id);
    };
    f.setTime(idleMs);
    const gone = new Promise<void>((resolve) => a.socket.once('disconnect', () => resolve()));
    a.socket.emit('CreateMatch', { commandId: randomUUID(), payload: {} });
    await gone;
    assert.equal(calls, 0);
    const b = await f.connect('bob');
    let admitted: ReturnType<MatchCoordinator['create']> | undefined;
    f.coordinator.create = (player, id) => {
      admitted = original(player, id);
      void f.auth.sessions.revoke(b.token);
      return admitted;
    };
    const bGone = new Promise<void>((resolve) => b.socket.once('disconnect', () => resolve()));
    b.socket.emit('CreateMatch', { commandId: randomUUID(), payload: {} });
    await bGone;
    assert.ok(admitted);
    const receipt = await admitted;
    assert.equal(receipt.outcome.status, 'accepted');
    assert.deepEqual(b.snapshots, []);
  },
);

test(
  'snapshot delivery rechecks exact expiry without a timer callback or idle refresh',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice');
    const { matchId } = await accepted(command(a, 'CreateMatch', {}));
    await snapshot(a, matchId, 1);
    f.setTime(100);
    const b = await f.connect('bob');
    const started = deferred(),
      release = deferred();
    f.lookup(async (id) => {
      started.resolve();
      await release.promise;
      return [...f.accounts.values()].find((p) => p.id === id) ?? null;
    });
    await accepted(command(b, 'JoinMatch', { matchId }));
    await started.promise;
    f.setTime(200);
    await command(a, 'LeaveMatch', { matchId }); // Intentional, rejected action extends only A's idle deadline.
    f.setTime(idleMs + 100);
    const gone = new Promise<void>((resolve) => b.socket.once('disconnect', () => resolve()));
    release.resolve();
    await snapshot(a, matchId, 2);
    await gone;
    assert.deepEqual(b.snapshots, []);
    f.setTime(idleMs + 200);
    assert.equal(await f.auth.sessions.resolve(a.token), null); // Delivery did not refresh idle.
  },
);

test(
  'revocation before the final admission check cannot call the Coordinator',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice');
    const act = f.auth.sessions.act.bind(f.auth.sessions);
    f.auth.sessions.act = (token, action) => {
      void f.auth.sessions.revoke(token);
      return act(token, action);
    };
    let admitted = false;
    f.coordinator.create = () => {
      admitted = true;
      throw new Error('Must not admit');
    };
    const gone = new Promise<void>((resolve) => a.socket.once('disconnect', () => resolve()));
    a.socket.emit('CreateMatch', { commandId: randomUUID(), payload: {} });
    await gone;
    assert.equal(admitted, false);
  },
);

test(
  'transport shutdown drains admitted work and closes the shared Coordinator and session timers',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice');
    const pending = f.coordinator.create(a.player.id, randomUUID());
    await f.server.close();
    const result = (await pending).outcome;
    assert.ok(result.status === 'accepted');
    assert.equal(f.coordinator.lookup(result.match.id).status, 'missing');
    assert.throws(() => f.coordinator.create(a.player.id, randomUUID()), /closed/);
    assert.equal(f.tasks.size, 0);
  },
);

test('Presenter allowlists fields, rejects active state and incomplete profiles', () => {
  const player = { id: randomUUID(), displayName: 'Trusted 👩‍💻' };
  const match = createMatch(player.id, randomUUID).match;
  const projection = presentLobby({ ...match, privateQuestions: ['SECRET'] } as typeof match, [
    { ...player, passwordHash: 'SECRET' } as PlayerProfile,
  ]);
  assert.deepEqual(Object.keys(projection), ['matchId', 'version', 'phase', 'state']);
  assert.deepEqual(Object.keys(projection.state), ['hostPlayerId', 'participants', 'rules']);
  assert.doesNotMatch(JSON.stringify(projection), /SECRET|private|password/);
  assert.throws(() => presentLobby(match, []));
  const active = startMatch(
    { ...match, participants: [player.id, randomUUID()] },
    player.id,
    Array.from({ length: 10 }, (_, i) => ({
      id: `q${i}`,
      text: 'Q',
      choices: [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ],
      correctChoiceId: 'a',
    })),
    0,
  );
  assert.ok(active.status === 'accepted');
  assert.throws(() => presentLobby(active.match, [player]));
});

test(
  'real PostgreSQL identities login and participate in the shared lobby',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 8_000 },
  async (t) => {
    const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }).database;
    const base = connectPostgres(config);
    assert.match((await base.query('SELECT current_database() AS name')).rows[0].name, /_test$/);
    const schema = 'lobby_' + randomUUID().replaceAll('-', '');
    await base.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ ...config, options: `-c search_path=${schema}` });
    t.after(async () => {
      await pool.end();
      await base.query(`DROP SCHEMA ${schema} CASCADE`);
      await base.end();
    });
    await applyMigrations(pool);
    const repository = new PlayerRepository(pool);
    const aProfile = await provisionPlayer(repository, 'Alice', ' Nguyễn 👩‍💻 ', 'fixture-password');
    const bProfile = await provisionPlayer(repository, 'Bob', 'Đặng', 'fixture-password');
    const f = await fixture(t, repository),
      a = await f.connect('ALICE'),
      b = await f.connect('bob');
    const { matchId } = await accepted(command(a, 'CreateMatch', {}));
    await accepted(command(b, 'JoinMatch', { matchId }));
    const joined = await snapshot(a, matchId, 2);
    assert.deepEqual(
      joined.state.participants,
      [aProfile, bProfile].map((p) => ({ playerId: p.id, displayName: p.displayName })),
    );
    await accepted(command(b, 'LeaveMatch', { matchId }));
    await snapshot(a, matchId, 3);
    await f.server.close();
  },
);
