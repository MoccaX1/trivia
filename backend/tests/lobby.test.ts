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
import type { MatchSnapshot } from '../src/application/match-presenter.js';
import { demoQuestions } from '../src/application/demo-questions.js';
import { MatchCompletions } from '../src/application/match-completions.js';
import type { HistoryReader } from '../src/application/history.js';
import { HistoryRepository } from '../src/persistence/history.js';
import {
  CompletedMatchRepository,
  readDurableMatch,
} from '../src/persistence/completed-matches.js';
import { CompletionError, durableMatch } from '../src/application/completed-match.js';
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
  active: MatchSnapshot[];
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

async function fixture(
  t: TestContext,
  repository?: PlayerRepository,
  completions?: MatchCompletions,
  history?: HistoryReader,
) {
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
  const coordinator = new MatchCoordinator(clock, scheduler, randomUUID, () => {}, completions);
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
    ...(completions ? { completions } : {}),
    ...(history ? { history } : {}),
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
      active: [] as MatchSnapshot[],
    };
    clients.push(client);
    socket.on('LobbySnapshot', (item) => client.snapshots.push(item));
    socket.on('MatchSnapshot', (item) => client.active.push(item));
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

function activeSnapshot(client: Client, version: number): Promise<MatchSnapshot> {
  const existing = client.active.find((item) => item.version === version);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const listener = (item: MatchSnapshot) => {
      if (item.version === version) {
        client.socket.off('MatchSnapshot', listener);
        resolve(item);
      }
    };
    client.socket.on('MatchSnapshot', listener);
  });
}

async function fireDeadline(f: Awaited<ReturnType<typeof fixture>>, matchId: string) {
  const found = f.coordinator.lookup(matchId);
  assert.ok(found.status === 'found');
  const match = found.match;
  assert.ok(match.phase === 'QUESTION_OPEN' || match.phase === 'REVEAL');
  const deadline =
    match.phase === 'QUESTION_OPEN' ? match.currentQuestion.deadlineAt : match.revealDeadlineAt;
  const timer = [...f.tasks].find((task) => task.at === deadline);
  assert.ok(timer);
  f.setTime(deadline);
  timer.callback();
  await f.coordinator.whenIdle(matchId);
  return timer;
}

async function playTen(
  f: Awaited<ReturnType<typeof fixture>>,
  a: Client,
  b: Client,
  matchId: string,
) {
  const startId = randomUUID();
  const start = await accepted(command(a, 'StartMatch', { matchId }, startId));
  let current = await activeSnapshot(a, start.version);
  await activeSnapshot(b, start.version);
  let stale: Awaited<ReturnType<typeof fireDeadline>> | undefined;
  for (let index = 0; index < 10; index++) {
    assert.ok(current.phase === 'QUESTION_OPEN');
    assert.equal(current.state.questionNumber, index + 1);
    assert.equal(current.state.question.questionId, demoQuestions()[index]!.id);
    assert.doesNotMatch(
      JSON.stringify(current),
      /correctChoice|ownResult|privateQuestions|resolvedQuestions/,
    );
    assert.equal(current.state.ownSubmission, undefined);
    if (index < 9) assert.ok(!JSON.stringify(current).includes(demoQuestions()[index + 1]!.text));
    f.setTime(Date.parse(current.state.deadlineAt) - 9_999);
    const payload = {
      matchId,
      questionId: current.state.question.questionId,
      choiceId: demoQuestions()[index]!.correctChoiceId,
    };
    const answerId = randomUUID();
    const first = await accepted(command(a, 'SubmitAnswer', payload, answerId));
    const own = await activeSnapshot(a, first.version),
      other = await activeSnapshot(b, first.version);
    assert.ok(own.phase === 'QUESTION_OPEN' && other.phase === 'QUESTION_OPEN');
    assert.equal(own.state.ownSubmission?.choiceId, payload.choiceId);
    assert.equal(other.state.ownSubmission, undefined);
    assert.deepEqual(await command(a, 'SubmitAnswer', payload, answerId), first);
    const second = await accepted(command(b, 'SubmitAnswer', payload));
    await activeSnapshot(a, second.version);
    stale = await fireDeadline(f, matchId);
    const reveal = await activeSnapshot(a, second.version + 1);
    await activeSnapshot(b, reveal.version);
    assert.ok(reveal.phase === 'REVEAL');
    assert.equal(reveal.state.questionNumber, index + 1);
    assert.equal(reveal.state.question.correctChoiceId, payload.choiceId);
    assert.equal(reveal.state.ownResult.correct, true);
    assert.equal(
      reveal.state.participants[0]!.score.scoreUnits,
      (BigInt(index + 1) * 59_997_000n).toString(),
    );
    assert.deepEqual(
      reveal.state.participants.map((p) => p.rank),
      [1, 1],
    );
    assert.doesNotMatch(
      JSON.stringify(reveal),
      /privateSubmissions|resolvedQuestions|password|token/,
    );
    await fireDeadline(f, matchId);
    current = await activeSnapshot(a, reveal.version + 1);
    await activeSnapshot(b, current.version);
    stale.callback(); // Old callbacks cannot mutate the next question or terminal state.
    await f.coordinator.whenIdle(matchId);
  }
  assert.ok(current.phase === 'FINISHED');
  assert.deepEqual(
    current.state.participants.map((p) => [p.score.scoreUnits, p.rank]),
    [
      ['599970000', 1],
      ['599970000', 1],
    ],
  );
  assert.deepEqual(Object.keys(current.state), ['participants']);
  const complete = f.coordinator.lookup(matchId);
  assert.ok(complete.status === 'found' && complete.match.phase === 'FINISHED');
  assert.equal(complete.match.result.resolvedQuestions.length, 10);
  assert.equal(
    complete.match.result.participants[0]!.finalScoreUnits.toString(),
    current.state.participants[0]!.score.scoreUnits,
  );
  assert.deepEqual(await command(a, 'StartMatch', { matchId }, startId), start);
  const terminal = await command(a, 'SubmitAnswer', {
    matchId,
    questionId: 'old',
    choiceId: 'old',
  });
  assert.ok(terminal.status === 'rejected' && terminal.error.code === 'MATCH_FINISHED');
  for (const client of [a, b]) {
    assert.equal(
      client.active.filter((s) => s.phase === 'QUESTION_OPEN' && !s.state.ownSubmission).length >=
        10,
      true,
    );
    assert.equal(client.active.filter((s) => s.phase === 'REVEAL').length, 10);
    assert.equal(client.active.filter((s) => s.phase === 'FINISHED').length, 1);
    const versions = client.active.map((s) => s.version);
    assert.deepEqual(
      versions,
      [...new Set(versions)].sort((x, y) => x - y),
    );
  }
}

for (const transport of ['polling', 'websocket']) {
  test(
    `${transport}: trusted Start/Answer and ten automatic per-question reveals finish safely`,
    { timeout: 10_000 },
    async (t) => {
      const f = await fixture(t),
        a = await f.connect('alice', transport),
        b = await f.connect('bob', transport);
      const { matchId } = await accepted(command(a, 'CreateMatch', {}));
      await accepted(command(b, 'JoinMatch', { matchId }));
      await playTen(f, a, b, matchId);
    },
  );
}

test(
  'active commands validate identity/content, Host eligibility, attempts and exclusive ingress deadline',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice'),
      b = await f.connect('bob');
    const { matchId } = await accepted(command(a, 'CreateMatch', {}));
    const insufficient = await command(a, 'StartMatch', { matchId });
    assert.ok(
      insufficient.status === 'rejected' && insufficient.error.code === 'INSUFFICIENT_PARTICIPANTS',
    );
    await accepted(command(b, 'JoinMatch', { matchId }));
    const unauthorized = await command(b, 'StartMatch', { matchId });
    assert.ok(unauthorized.status === 'rejected' && unauthorized.error.code === 'NOT_HOST');
    for (const [event, payload] of [
      ['StartMatch', { matchId, questions: demoQuestions() }],
      ['StartMatch', { matchId, playerId: a.player.id }],
      ['SubmitAnswer', { matchId, questionId: 'x', choiceId: 'x', receivedAt: 0 }],
    ] as const) {
      const ack = await command(b, event, payload);
      assert.ok(ack.status === 'error' && ack.error.code === 'INVALID_REQUEST');
    }
    const started = await accepted(command(a, 'StartMatch', { matchId }));
    const initial = await activeSnapshot(a, started.version);
    assert.ok(initial.phase === 'QUESTION_OPEN');
    const q = initial.state.question;
    const payload = { matchId, questionId: q.questionId, choiceId: q.choices[0]!.choiceId };
    const first = await accepted(command(a, 'SubmitAnswer', payload));
    assert.equal((await accepted(command(a, 'SubmitAnswer', payload))).version, first.version);
    for (const choice of q.choices.slice(1, 3))
      await accepted(command(a, 'SubmitAnswer', { ...payload, choiceId: choice.choiceId }));
    const exhausted = await command(a, 'SubmitAnswer', {
      ...payload,
      choiceId: q.choices[3]!.choiceId,
    });
    assert.ok(exhausted.status === 'rejected' && exhausted.error.code === 'MAX_ATTEMPTS_EXCEEDED');
    const repeatedStart = await command(a, 'StartMatch', { matchId });
    assert.ok(
      repeatedStart.status === 'rejected' && repeatedStart.error.code === 'INVALID_MATCH_PHASE',
    );
    const invalid = await command(b, 'SubmitAnswer', { ...payload, choiceId: 'not-a-choice' });
    assert.ok(invalid.status === 'rejected' && invalid.error.code === 'INVALID_CHOICE');
    f.setTime(Date.parse(initial.state.deadlineAt) - 1);
    await accepted(command(b, 'SubmitAnswer', payload));
    f.setTime(Date.parse(initial.state.deadlineAt));
    const late = await command(b, 'SubmitAnswer', payload);
    assert.ok(late.status === 'rejected' && late.error.code === 'ANSWER_WINDOW_CLOSED');
  },
);

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

for (const event of ['StartMatch', 'SubmitAnswer'] as const) {
  for (const boundary of ['before', 'after'] as const) {
    test(
      `${event}: revocation ${boundary} admission preserves trusted boundary`,
      { timeout: 8_000 },
      async (t) => {
        const f = await fixture(t),
          a = await f.connect('alice'),
          b = await f.connect('bob');
        const { matchId } = await accepted(command(a, 'CreateMatch', {}));
        await accepted(command(b, 'JoinMatch', { matchId }));
        if (event === 'SubmitAnswer') {
          const started = await accepted(command(a, 'StartMatch', { matchId }));
          await activeSnapshot(a, started.version);
        }
        const payload =
          event === 'StartMatch'
            ? { matchId }
            : {
                matchId,
                questionId: demoQuestions()[0]!.id,
                choiceId: demoQuestions()[0]!.correctChoiceId,
              };
        const dispatch = f.coordinator.dispatch.bind(f.coordinator);
        let admitted: ReturnType<typeof dispatch> | undefined;
        f.coordinator.dispatch = (player, id, input) => {
          admitted = dispatch(player, id, input);
          if (boundary === 'after') void f.auth.sessions.revoke(a.token);
          return admitted;
        };
        if (boundary === 'before') {
          const act = f.auth.sessions.act.bind(f.auth.sessions);
          f.auth.sessions.act = (token, action) => {
            void f.auth.sessions.revoke(token);
            return act(token, action);
          };
        }
        const gone = new Promise<void>((resolve) => a.socket.once('disconnect', () => resolve()));
        a.socket.emit(event, { commandId: randomUUID(), payload });
        await gone;
        if (boundary === 'before') assert.equal(admitted, undefined);
        else {
          assert.ok(admitted);
          const result = await admitted;
          assert.ok(result.outcome.status === 'accepted');
          await activeSnapshot(b, result.outcome.match.version);
        }
      },
    );
  }
}

test(
  'another Host session can act but Start/Answer cannot implicitly subscribe its socket',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice'),
      b = await f.connect('bob'),
      other = await f.connect('alice');
    const { matchId } = await accepted(command(a, 'CreateMatch', {}));
    await accepted(command(b, 'JoinMatch', { matchId }));
    const start = await accepted(command(other, 'StartMatch', { matchId }));
    await activeSnapshot(a, start.version);
    const answered = await accepted(
      command(other, 'SubmitAnswer', {
        matchId,
        questionId: demoQuestions()[0]!.id,
        choiceId: demoQuestions()[0]!.correctChoiceId,
      }),
    );
    await activeSnapshot(a, answered.version);
    await barrier(other);
    assert.deepEqual(other.active, []);
    assert.deepEqual(other.snapshots, []);
  },
);

for (const action of ['logout', 'shutdown'] as const) {
  test(
    `active coalescing and ${action} during enrichment preserve accepted Start and delivery authorization`,
    { timeout: 8_000 },
    async (t) => {
      const f = await fixture(t),
        a = await f.connect('alice'),
        b = await f.connect('bob');
      const { matchId } = await accepted(command(a, 'CreateMatch', {}));
      await accepted(command(b, 'JoinMatch', { matchId }));
      await snapshot(b, matchId, 2);
      const release = deferred();
      t.after(release.resolve);
      let reads = 0;
      f.lookup(async (id) => {
        reads++;
        await release.promise;
        return [...f.accounts.values()].find((p) => p.id === id) ?? null;
      });
      const startId = randomUUID();
      const start = await accepted(command(a, 'StartMatch', { matchId }, startId));
      const retries = await Promise.all(
        Array.from({ length: 20 }, () => command(a, 'StartMatch', { matchId }, startId)),
      );
      assert.ok(retries.every((ack) => JSON.stringify(ack) === JSON.stringify(start)));
      assert.equal(reads, 2);
      assert.deepEqual(a.active, []);
      if (action === 'logout') {
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
      } else await f.server.close();
      release.resolve();
      if (action === 'logout') await activeSnapshot(a, start.version);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(b.active, []);
      if (action === 'shutdown') assert.deepEqual(a.active, []);
      assert.equal(reads, 2);
    },
  );
}

test(
  'stale active enrichment cannot overwrite a newer Answer/REVEAL and viewer results stay private',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice'),
      b = await f.connect('bob');
    const { matchId } = await accepted(command(a, 'CreateMatch', {}));
    await accepted(command(b, 'JoinMatch', { matchId }));
    await snapshot(b, matchId, 2);
    const release = deferred();
    t.after(release.resolve);
    f.lookup(async (id) => {
      await release.promise;
      return [...f.accounts.values()].find((p) => p.id === id) ?? null;
    });
    const start = await accepted(command(a, 'StartMatch', { matchId }));
    f.lookup(async (id) => [...f.accounts.values()].find((p) => p.id === id) ?? null);
    const q = demoQuestions()[0]!;
    await accepted(
      command(a, 'SubmitAnswer', { matchId, questionId: q.id, choiceId: q.correctChoiceId }),
    );
    const second = await accepted(
      command(b, 'SubmitAnswer', { matchId, questionId: q.id, choiceId: q.choices[1]!.id }),
    );
    await activeSnapshot(a, second.version);
    await fireDeadline(f, matchId);
    const av = await activeSnapshot(a, second.version + 1),
      bv = await activeSnapshot(b, second.version + 1);
    assert.ok(av.phase === 'REVEAL' && bv.phase === 'REVEAL');
    assert.equal(av.state.ownResult.selectedChoiceId, q.correctChoiceId);
    assert.equal(bv.state.ownResult.selectedChoiceId, q.choices[1]!.id);
    assert.equal(av.state.ownResult.correct, true);
    assert.equal(bv.state.ownResult.correct, false);
    assert.deepEqual(Object.keys(av.state), [
      'questionNumber',
      'questionCount',
      'question',
      'revealEndsAt',
      'participants',
      'ownResult',
    ]);
    release.resolve();
    await barrier(a);
    assert.ok(!a.active.some((s) => s.version === start.version));
    assert.equal(a.active.at(-1)!.phase, 'REVEAL');
    assert.deepEqual(
      a.active.map((s) => s.version),
      [...new Set(a.active.map((s) => s.version))].sort((x, y) => x - y),
    );
  },
);

test(
  'active delivery enforces expiry while enrichment is pending without refreshing idle',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice'),
      b = await f.connect('bob');
    const { matchId } = await accepted(command(a, 'CreateMatch', {}));
    await accepted(command(b, 'JoinMatch', { matchId }));
    await snapshot(b, matchId, 2);
    const release = deferred();
    t.after(release.resolve);
    f.lookup(async (id) => {
      await release.promise;
      return [...f.accounts.values()].find((p) => p.id === id) ?? null;
    });
    f.setTime(100);
    const start = await accepted(command(a, 'StartMatch', { matchId }));
    f.setTime(idleMs);
    const gone = new Promise<void>((resolve) => b.socket.once('disconnect', () => resolve()));
    release.resolve();
    await activeSnapshot(a, start.version);
    await gone;
    assert.deepEqual(b.active, []);
    f.setTime(idleMs + 100);
    assert.equal(await f.auth.sessions.resolve(a.token), null);
  },
);

test(
  'Answer retries coalesce with pending enrichment and timer publication supersedes them safely',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice'),
      b = await f.connect('bob');
    const { matchId } = await accepted(command(a, 'CreateMatch', {}));
    await accepted(command(b, 'JoinMatch', { matchId }));
    const start = await accepted(command(a, 'StartMatch', { matchId }));
    await activeSnapshot(a, start.version);
    await activeSnapshot(b, start.version);
    let reads = 0;
    const release = deferred();
    t.after(release.resolve);
    f.lookup(async (id) => {
      reads++;
      await release.promise;
      return [...f.accounts.values()].find((p) => p.id === id) ?? null;
    });
    const payload = {
        matchId,
        questionId: demoQuestions()[0]!.id,
        choiceId: demoQuestions()[0]!.correctChoiceId,
      },
      id = randomUUID();
    const answer = await accepted(command(a, 'SubmitAnswer', payload, id));
    await Promise.all(Array.from({ length: 20 }, () => command(a, 'SubmitAnswer', payload, id)));
    assert.equal(reads, 2);
    await fireDeadline(f, matchId);
    assert.equal(reads, 4);
    release.resolve();
    const reveal = await activeSnapshot(a, answer.version + 1);
    assert.ok(reveal.phase === 'REVEAL');
    await barrier(a);
    assert.equal(reads, 4);
    assert.ok(!a.active.some((s) => s.version === answer.version));
    assert.equal(a.active.filter((s) => s.phase === 'REVEAL').length, 1);
  },
);

test(
  'synchronous publication failure preserves accepted Start and a later event can recover projection',
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice'),
      b = await f.connect('bob');
    const { matchId } = await accepted(command(a, 'CreateMatch', {}));
    await accepted(command(b, 'JoinMatch', { matchId }));
    await snapshot(b, matchId, 2);
    const lookup = f.coordinator.lookup.bind(f.coordinator);
    f.coordinator.lookup = () => {
      throw new Error('PRIVATE_PUBLICATION_FAILURE');
    };
    const start = await accepted(command(a, 'StartMatch', { matchId }));
    await barrier(a);
    assert.match(f.logs(), /LOBBY_PROFILE_FAILURE/);
    assert.doesNotMatch(f.logs(), /PRIVATE_PUBLICATION_FAILURE|LOBBY_COMMAND_FAILURE/);
    f.coordinator.lookup = lookup;
    const found = lookup(matchId);
    assert.ok(found.status === 'found' && found.match.phase === 'QUESTION_OPEN');
    await command(a, 'StartMatch', { matchId }); // Rejection is still a valid opportunity to recover publication.
    const projected = await activeSnapshot(a, start.version);
    assert.equal(projected.phase, 'QUESTION_OPEN');
  },
);

test(
  'failed completion persistence preserves live FINISHED and controlled retry never changes snapshots',
  { timeout: 8_000 },
  async (t) => {
    let reject!: (error: unknown) => void;
    const pending = new Promise<void>((_resolve, no) => {
      reject = no;
    });
    let calls = 0;
    const completions = new MatchCompletions({
      save: async () => {
        if (++calls === 1) await pending;
      },
    });
    const f = await fixture(t, undefined, completions),
      a = await f.connect('alice'),
      b = await f.connect('bob');
    const { matchId } = await accepted(command(a, 'CreateMatch', {}));
    await accepted(command(b, 'JoinMatch', { matchId }));
    await playTen(f, a, b, matchId);
    const before = f.coordinator.lookup(matchId);
    assert.ok(before.status === 'found' && before.match.phase === 'FINISHED');
    const snapshots = a.active.length;
    reject(new CompletionError('COMPLETION_UNCONFIRMED'));
    assert.equal((await completions.capture(before.match.result)).status, 'unconfirmed');
    const retry = completions.retry(matchId);
    assert.strictEqual(completions.retry(matchId), retry);
    assert.equal((await retry).status, 'succeeded');
    const after = f.coordinator.lookup(matchId);
    assert.ok(after.status === 'found');
    assert.strictEqual(after.match, before.match);
    await barrier(a);
    assert.equal(a.active.length, snapshots);
    assert.equal(calls, 2);
  },
);

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

test('A3-01: published Create/Join retries do not repeat enrichment or snapshots', async (t) => {
  const f = await fixture(t),
    a = await f.connect('alice'),
    b = await f.connect('bob');
  const createId = randomUUID(),
    joinId = randomUUID();
  const created = await accepted(command(a, 'CreateMatch', {}, createId));
  await snapshot(a, created.matchId, 1);
  const joined = await accepted(command(b, 'JoinMatch', { matchId: created.matchId }, joinId));
  await snapshot(a, created.matchId, 2);
  await snapshot(b, created.matchId, 2);
  let reads = 0;
  f.lookup(async (id) => {
    reads++;
    return [...f.accounts.values()].find((p) => p.id === id) ?? null;
  });
  const retries = await Promise.all(
    Array.from({ length: 20 }, () => [
      command(a, 'CreateMatch', {}, createId),
      command(b, 'JoinMatch', { matchId: created.matchId }, joinId),
    ]).flat(),
  );
  assert.deepEqual(retries, Array.from({ length: 20 }, () => [created, joined]).flat());
  await barrier(a);
  await barrier(b);
  assert.equal(reads, 0);
  assert.deepEqual(
    a.snapshots.map((item) => item.version),
    [1, 2],
  );
  assert.deepEqual(
    b.snapshots.map((item) => item.version),
    [2],
  );
});

test('A3-01: concurrent requests share enrichment of the current version', async (t) => {
  const f = await fixture(t),
    a = await f.connect('alice'),
    b = await f.connect('bob');
  const createId = randomUUID(),
    joinId = randomUUID();
  const { matchId } = await accepted(command(a, 'CreateMatch', {}, createId));
  await snapshot(a, matchId, 1);
  const release = deferred();
  t.after(release.resolve);
  let reads = 0;
  f.lookup(async (id) => {
    reads++;
    await release.promise;
    return [...f.accounts.values()].find((p) => p.id === id) ?? null;
  });
  const joined = await accepted(command(b, 'JoinMatch', { matchId }, joinId));
  await Promise.all(
    Array.from({ length: 20 }, () => [
      command(a, 'CreateMatch', {}, createId),
      command(b, 'JoinMatch', { matchId }, joinId),
    ]).flat(),
  );
  assert.equal(reads, 2);
  assert.equal(b.snapshots.length, 0);
  release.resolve();
  await snapshot(a, matchId, joined.version);
  await snapshot(b, matchId, joined.version);
  await accepted(command(b, 'LeaveMatch', { matchId }));
  await snapshot(a, matchId, 3);
  assert.equal(reads, 3);
  assert.deepEqual(
    a.snapshots.map((item) => item.version),
    [1, 2, 3],
  );
  assert.deepEqual(
    b.snapshots.map((item) => item.version),
    [2],
  );
});

test('A3-01: failed coalesced enrichment can be retried by a later cached command', async (t) => {
  const f = await fixture(t),
    a = await f.connect('alice');
  const release = deferred();
  t.after(release.resolve);
  let reads = 0;
  f.lookup(async () => {
    reads++;
    await release.promise;
    throw new Error('PRIVATE_PROFILE_FAILURE');
  });
  const createId = randomUUID();
  const created = await accepted(command(a, 'CreateMatch', {}, createId));
  await Promise.all(Array.from({ length: 20 }, () => command(a, 'CreateMatch', {}, createId)));
  assert.equal(reads, 1);
  release.resolve();
  await barrier(a);
  assert.deepEqual(a.snapshots, []);
  assert.match(f.logs(), /LOBBY_PROFILE_FAILURE/);
  assert.doesNotMatch(f.logs(), /PRIVATE_PROFILE_FAILURE/);
  f.lookup(async (id) => {
    reads++;
    return [...f.accounts.values()].find((p) => p.id === id) ?? null;
  });
  assert.deepEqual(await command(a, 'CreateMatch', {}, createId), created);
  await snapshot(a, created.matchId, 1);
  await command(a, 'CreateMatch', {}, createId);
  await barrier(a);
  assert.equal(reads, 2);
  assert.equal(a.snapshots.length, 1);
});

test('A3-01: obsolete completion cannot clear newer in-flight enrichment', async (t) => {
  const f = await fixture(t),
    a = await f.connect('alice'),
    b = await f.connect('bob'),
    c = await f.connect('carol');
  const createId = randomUUID();
  const { matchId } = await accepted(command(a, 'CreateMatch', {}, createId));
  await snapshot(a, matchId, 1);
  const oldRelease = deferred(),
    newRelease = deferred(),
    oldFinished = deferred();
  t.after(() => {
    oldRelease.resolve();
    newRelease.resolve();
  });
  f.lookup(async (id) => {
    await oldRelease.promise;
    oldFinished.resolve();
    return [...f.accounts.values()].find((p) => p.id === id) ?? null;
  });
  await accepted(command(b, 'JoinMatch', { matchId }));
  let reads = 0;
  f.lookup(async (id) => {
    reads++;
    await newRelease.promise;
    return [...f.accounts.values()].find((p) => p.id === id) ?? null;
  });
  await accepted(command(c, 'JoinMatch', { matchId }));
  oldRelease.resolve();
  await oldFinished.promise;
  await barrier(a);
  await Promise.all(Array.from({ length: 20 }, () => command(a, 'CreateMatch', {}, createId)));
  assert.equal(reads, 3);
  newRelease.resolve();
  await snapshot(a, matchId, 3);
  await snapshot(b, matchId, 3);
  await snapshot(c, matchId, 3);
  assert.deepEqual(
    a.snapshots.map((item) => item.version),
    [1, 3],
  );
  assert.deepEqual(
    b.snapshots.map((item) => item.version),
    [3],
  );
});

for (const action of ['disconnect', 'shutdown'] as const) {
  test(`A3-01: ${action} during enrichment prevents subsequent delivery`, async (t) => {
    const f = await fixture(t),
      a = await f.connect('alice'),
      b = await f.connect('bob');
    const { matchId } = await accepted(command(a, 'CreateMatch', {}));
    await snapshot(a, matchId, 1);
    const release = deferred();
    t.after(release.resolve);
    let reads = 0;
    f.lookup(async (id) => {
      reads++;
      await release.promise;
      return [...f.accounts.values()].find((p) => p.id === id) ?? null;
    });
    await accepted(command(b, 'JoinMatch', { matchId }));
    assert.equal(reads, 2);
    if (action === 'shutdown') await f.server.close();
    else b.socket.disconnect();
    release.resolve();
    if (action === 'disconnect') await snapshot(a, matchId, 2);
    // Drain the released enrichment without relying on a wall-clock delay.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(b.snapshots, []);
    assert.deepEqual(
      a.snapshots.map((item) => item.version),
      action === 'shutdown' ? [1] : [1, 2],
    );
    assert.equal(reads, 2);
  });
}

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
    const before = await f.connect('bob');
    f.setTime(idleMs - 1);
    await accepted(command(before, 'CreateMatch', {}));
    assert.equal(calls, 1);
    f.setTime(idleMs);
    const gone = new Promise<void>((resolve) => a.socket.once('disconnect', () => resolve()));
    a.socket.emit('CreateMatch', { commandId: randomUUID(), payload: {} });
    await gone;
    assert.equal(calls, 1);
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
    const completions = new MatchCompletions(new CompletedMatchRepository(pool));
    const f = await fixture(t, repository, completions, new HistoryRepository(pool)),
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
    await accepted(command(b, 'JoinMatch', { matchId }));
    await playTen(f, a, b, matchId);
    const finished = f.coordinator.lookup(matchId);
    assert.ok(finished.status === 'found' && finished.match.phase === 'FINISHED');
    assert.equal((await completions.capture(finished.match.result)).status, 'succeeded');
    assert.equal(completions.outcome(matchId)?.attempt, 1);
    const fresh = new pg.Client({ ...config, options: `-c search_path=${schema}` });
    await fresh.connect();
    try {
      assert.deepEqual(await readDurableMatch(fresh, matchId), durableMatch(finished.match.result));
    } finally {
      await fresh.end();
    }
    const list = await f.server.inject({ url: '/%68istory', headers: { cookie: a.cookie } });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items[0].matchId, matchId);
    const detail = await f.server.inject({
      url: `/history/${matchId}`,
      headers: { cookie: b.cookie },
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().questions.length, 10);
    assert.deepEqual(
      detail
        .json()
        .participants.map((p: { score: { scoreUnits: string }; rank: number }) => ({
          scoreUnits: p.score.scoreUnits,
          rank: p.rank,
        }))
        .sort((a: { scoreUnits: string }, b: { scoreUnits: string }) =>
          a.scoreUnits.localeCompare(b.scoreUnits),
        ),
      finished.match.result.participants
        .map((p) => ({ scoreUnits: p.finalScoreUnits.toString(), rank: p.finalRank }))
        .sort((a, b) => a.scoreUnits.localeCompare(b.scoreUnits)),
    );
    const outsider = await f.auth.sessions.create({
      id: randomUUID(),
      displayName: 'Nonparticipant',
    });
    const denied = await f.server.inject({
      url: `/history/${matchId}`,
      headers: { cookie: `trivia_session=${outsider}` },
    });
    assert.equal(denied.statusCode, 404);
    await f.server.close();
  },
);
