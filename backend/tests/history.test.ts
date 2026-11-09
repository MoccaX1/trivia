import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import pg from 'pg';
import { HistoryError, encodeHistoryCursor, historyPage } from '../src/application/history.js';
import type { HistoryReader, HistoryList } from '../src/application/history.js';
import { MemorySessionStore, idleMs } from '../src/application/sessions.js';
import { createServer } from '../src/transport/server.js';
import { HistoryRepository } from '../src/persistence/history.js';
import { CompletedMatchRepository } from '../src/persistence/completed-matches.js';
import { applyMigrations } from '../src/persistence/migrations.js';
import { readConfig } from '../src/config.js';
import { connectPostgres } from '../src/persistence/postgres.js';
import { completedResult } from './support/completed-match.js';
import { fixturePlayer, testAuth } from './support/auth.js';

const origin = 'http://localhost';
const empty: HistoryList = { items: [], nextCursor: null };
const paths = ['/history', '/%68istory', '/h%69story'];
const detailPaths = (id: string) => paths.map((p) => `${p}/${id}`);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function httpFixture(
  t: TestContext,
  reader: HistoryReader = {
    listForPlayer: async () => empty,
    findDetailForPlayer: async () => null,
  },
) {
  let now = 0;
  const auth = testAuth();
  await auth.sessions.close();
  auth.sessions = new MemorySessionStore({ now: () => now }, { schedule: () => () => {} });
  const token = await auth.sessions.create(fixturePlayer);
  const logs: string[] = [];
  const server = createServer({
    auth,
    history: reader,
    logger: {
      level: 'error',
      stream: new Writable({
        write(chunk, _encoding, callback) {
          logs.push(String(chunk));
          callback();
        },
      }),
    },
  });
  t.after(() => server.close());
  return {
    server,
    auth,
    token,
    cookie: `trivia_session=${token}`,
    logs,
    setTime: (value: number) => {
      now = value;
    },
  };
}

test('A6-01: malformed URL components fail safely before routing on a real listener', async (t) => {
  let reads = 0;
  const f = await httpFixture(t, {
    listForPlayer: async () => {
      reads++;
      return empty;
    },
    findDetailForPlayer: async () => {
      reads++;
      return null;
    },
  });
  f.server.get('/test-failure', async () => {
    throw new Error('PRIVATE_INTERNAL_CONTEXT');
  });
  const address = new URL(await f.server.listen({ host: '127.0.0.1', port: 0 }));
  for (const path of ['/history/%', '/history/%ZZ', '/history/%C0%AF', '/history/%ED%A0%80']) {
    for (const headers of [
      {},
      { cookie: f.cookie },
      { cookie: f.cookie, origin: 'http://evil.test' },
      { cookie: f.cookie, origin: 'null' },
    ]) {
      // Supply the raw path to Node HTTP; no client-side URL normalization/decoding.
      const response = await new Promise<{
        status: number | undefined;
        headers: IncomingHttpHeaders;
        body: string;
      }>((resolve, reject) => {
        const outgoing = request(
          { hostname: address.hostname, port: address.port, path, headers },
          (incoming) => {
            let body = '';
            incoming.setEncoding('utf8');
            incoming.on('data', (chunk: string) => {
              body += chunk;
            });
            incoming.on('error', reject);
            incoming.on('end', () =>
              resolve({ status: incoming.statusCode, headers: incoming.headers, body }),
            );
          },
        );
        outgoing.on('error', reject);
        outgoing.end();
      });
      assert.equal(response.status, 400);
      assert.deepEqual(JSON.parse(response.body), { code: 'INVALID_REQUEST' });
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['set-cookie'], undefined);
      assert.ok(!response.body.includes(path));
      assert.doesNotMatch(response.body, /FST_ERR|message|statusCode|player|session|question/);
    }
  }
  assert.equal(reads, 0);
  assert.equal((await fetch(`${address.origin}/health`)).status, 200);
  const valid = await fetch(`${address.origin}/%68istory`, { headers: { Cookie: f.cookie } });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), empty);
  assert.equal(reads, 1);
  const failure = await fetch(`${address.origin}/test-failure`);
  assert.equal(failure.status, 500);
  assert.deepEqual(await failure.json(), { code: 'INTERNAL_ERROR' });
});

test('History cursor is canonical, bounded, versioned and strictly validated', () => {
  const position = { finishedAt: '2026-11-09T01:02:03.456Z', matchId: randomUUID() };
  assert.deepEqual(historyPage({}), { limit: 20 });
  assert.deepEqual(historyPage({ limit: '50', cursor: encodeHistoryCursor(position) }), {
    limit: 50,
    cursor: position,
  });
  for (const limit of ['0', '-1', '51', '1.5', '01', ' 1', '1 ', '1e1', '', ['1', '2']])
    assert.throws(() => historyPage({ limit }), /INVALID_REQUEST/);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const cursor of [
    '',
    '*',
    'a'.repeat(513),
    encode({ v: 2, ...position }),
    encode({ v: 1, ...position, extra: true }),
    encode({ v: 1, ...position, matchId: 'bad' }),
    encode({ v: 1, ...position, matchId: position.matchId.toUpperCase() }),
    encode({ v: 1, ...position, finishedAt: '2026-02-30T01:02:03.456Z' }),
    encode({ v: 1, ...position, finishedAt: '2026-11-09T01:02:03Z' }),
    encode({ v: 1, ...position }) + '=',
    encode({ v: 1, ...position }).slice(1),
  ])
    assert.throws(() => historyPage({ cursor }), /INVALID_REQUEST/);
  assert.throws(() => historyPage({ playerId: randomUUID() }), /INVALID_REQUEST/);
});

test('History canonical and encoded routes enforce session, Origin, transport, CORS and no-store', async (t) => {
  let calls = 0;
  const f = await httpFixture(t, {
    listForPlayer: async (player) => {
      calls++;
      assert.equal(player, fixturePlayer.id);
      return empty;
    },
    findDetailForPlayer: async () => {
      calls++;
      return null;
    },
  });
  for (const url of [...paths, ...detailPaths(randomUUID())]) {
    for (const value of [undefined, origin]) {
      const response = await f.server.inject({
        url,
        headers: { cookie: f.cookie, ...(value ? { origin: value } : {}) },
      });
      assert.equal(response.statusCode, paths.includes(url) ? 200 : 404);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['set-cookie'], undefined);
      if (value) {
        assert.equal(response.headers['access-control-allow-origin'], origin);
        assert.equal(response.headers['access-control-allow-credentials'], 'true');
      }
    }
    for (const bad of ['null', 'http://evil.test']) {
      const before = calls;
      const response = await f.server.inject({ url, headers: { cookie: f.cookie, origin: bad } });
      assert.equal(response.statusCode, 403);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(calls, before);
    }
    const denied = await f.server.inject({ url });
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.headers['cache-control'], 'no-store');
    assert.equal(
      (await f.server.inject({ url, remoteAddress: '203.0.113.7', headers: { cookie: f.cookie } }))
        .statusCode,
      403,
    );
    const preflight = await f.server.inject({
      method: 'OPTIONS',
      url,
      headers: { origin, 'access-control-request-method': 'GET' },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-methods'], 'GET');
    assert.equal(
      (
        await f.server.inject({
          method: 'OPTIONS',
          url,
          headers: { origin, 'access-control-request-method': 'POST' },
        })
      ).statusCode,
      403,
    );
  }
});

test('History rejects malformed, repeated, unknown and identity query fields before SQL', async (t) => {
  let calls = 0;
  const f = await httpFixture(t, {
    listForPlayer: async () => {
      calls++;
      return empty;
    },
    findDetailForPlayer: async () => {
      calls++;
      return null;
    },
  });
  for (const suffix of [
    '?limit=0',
    '?limit=51',
    '?limit=1.5',
    '?limit=1&limit=2',
    '?cursor=a&cursor=b',
    '?cursor=bad',
    '?foo=1',
    '?playerId=' + randomUUID(),
    '?limit=01',
    '?limit=%201',
  ]) {
    const response = await f.server.inject({
      url: '/%68istory' + suffix,
      headers: { cookie: f.cookie },
    });
    assert.equal(response.statusCode, 400, suffix);
    assert.equal(response.json().code, 'INVALID_REQUEST');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  for (const url of ['/history/not-a-uuid', `/history/${randomUUID()}?playerId=x`])
    assert.equal((await f.server.inject({ url, headers: { cookie: f.cookie } })).statusCode, 400);
  assert.equal(calls, 0);
});

for (const action of ['expire', 'revoke'] as const) {
  test(`History rechecks ${action} during deferred SQL and discards private response`, async (t) => {
    const waiting = deferred<HistoryList>(),
      entered = deferred<void>();
    const f = await httpFixture(t, {
      listForPlayer: async () => {
        entered.resolve();
        return waiting.promise;
      },
      findDetailForPlayer: async () => null,
    });
    const response = f.server.inject({ url: '/history', headers: { cookie: f.cookie } });
    await entered.promise;
    if (action === 'expire') f.setTime(idleMs);
    else await f.auth.sessions.revoke(f.token);
    waiting.resolve(empty);
    const result = await response;
    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.json(), { code: 'UNAUTHENTICATED' });
    assert.equal(result.headers['cache-control'], 'no-store');
  });
}

test('passive History requests never refresh idle or issue cookies, including expired/revoked ingress', async (t) => {
  const f = await httpFixture(t);
  f.setTime(idleMs - 1);
  assert.equal(
    (await f.server.inject({ url: '/history', headers: { cookie: f.cookie } })).statusCode,
    200,
  );
  f.setTime(idleMs);
  assert.equal(
    (await f.server.inject({ url: '/history', headers: { cookie: f.cookie } })).statusCode,
    401,
  );
  const other = await f.auth.sessions.create(fixturePlayer);
  await f.auth.sessions.revoke(other);
  assert.equal(
    (await f.server.inject({ url: '/history', headers: { cookie: `trivia_session=${other}` } }))
      .statusCode,
    401,
  );
});

for (const [code, status, publicCode] of [
  ['HISTORY_UNAVAILABLE', 503, 'HISTORY_UNAVAILABLE'],
  ['HISTORY_INTEGRITY_FAILURE', 500, 'INTERNAL_ERROR'],
] as const) {
  test(`History maps ${code} safely on canonical/encoded routes`, async (t) => {
    const f = await httpFixture(t, {
      listForPlayer: async () => {
        throw new HistoryError(code);
      },
      findDetailForPlayer: async () => {
        throw new HistoryError(code);
      },
    });
    for (const url of [...paths, ...detailPaths(randomUUID())]) {
      const response = await f.server.inject({ url, headers: { cookie: f.cookie } });
      assert.equal(response.statusCode, status);
      assert.deepEqual(response.json(), { code: publicCode });
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.doesNotMatch(f.logs.join(''), new RegExp(f.token));
  });
}

async function fixture(t: TestContext) {
  const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }).database;
  const base = connectPostgres(config);
  assert.match((await base.query('SELECT current_database() AS name')).rows[0].name, /_test$/);
  const schema = 'history_' + randomUUID().replaceAll('-', '');
  await base.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...config, options: `-c search_path=${schema}`, max: 5 });
  t.after(async () => {
    await pool.end();
    await base.query(`DROP SCHEMA ${schema} CASCADE`);
    await base.end();
  });
  await applyMigrations(pool);
  const players = Array.from({ length: 4 }, () => randomUUID());
  for (const [index, id] of players.entries())
    await pool.query('INSERT INTO player VALUES($1,$2)', [id, `Current Player ${index}`]);
  return {
    pool,
    players,
    writer: new CompletedMatchRepository(pool),
    reader: new HistoryRepository(pool),
  };
}
const integration = { skip: !process.env.TEST_DATABASE_URL, timeout: 15000 };

test(
  'real History list is bounded, participant-filtered, exact and deterministically keyset-paginated',
  integration,
  async (t) => {
    const f = await fixture(t),
      player = f.players[0]!;
    assert.deepEqual(await f.reader.listForPlayer(player, { limit: 20 }), empty);
    const template = completedResult(f.players.slice(0, 3));
    const ids = Array.from({ length: 53 }, () => randomUUID())
      .sort()
      .reverse();
    for (const matchId of ids) await f.writer.save({ ...template, matchId });
    await f.writer.save(completedResult(f.players.slice(1)));
    const first = await f.reader.listForPlayer(player, { limit: 20 });
    assert.equal(first.items.length, 20);
    assert.deepEqual(
      first.items.map((i) => i.matchId),
      ids.slice(0, 20),
    );
    assert.ok(
      first.items.every(
        (i) =>
          i.participantCount === 3 &&
          typeof i.ownResult.score.scoreUnits === 'string' &&
          i.ownResult.rank === 1,
      ),
    );
    assert.equal(first.nextCursor, encodeHistoryCursor(first.items.at(-1)!));
    const second = await f.reader.listForPlayer(
      player,
      historyPage({ limit: '50', cursor: first.nextCursor }),
    );
    assert.deepEqual(
      second.items.map((i) => i.matchId),
      ids.slice(20),
    );
    assert.equal(second.nextCursor, null);
    const maximum = await f.reader.listForPlayer(player, { limit: 50 });
    assert.equal(maximum.items.length, 50);
    const altered = encodeHistoryCursor({
      finishedAt: new Date(template.finishedAt + 1).toISOString(),
      matchId: randomUUID(),
    });
    assert.equal(
      (await f.reader.listForPlayer(player, historyPage({ cursor: altered }))).items.length,
      20,
    );
    assert.deepEqual(
      await f.reader.listForPlayer(f.players[3]!, historyPage({ cursor: altered })),
      {
        items: (await f.reader.listForPlayer(f.players[3]!, { limit: 20 })).items,
        nextCursor: null,
      },
    );
    const index = (
      await f.pool.query(
        "SELECT indexdef FROM pg_indexes WHERE indexname='match_participant_history'",
      )
    ).rows[0].indexdef;
    assert.match(index, /player_id, finished_at DESC, match_id DESC/);
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      // Planner-only scale fixture, rolled back; not represented as complete gameplay results.
      await client.query(
        `INSERT INTO game_match
        SELECT md5('history-plan-'||n)::uuid,$1,$2,$3 FROM generate_series(1,2000) n`,
        [player, new Date(template.startedAt), new Date(template.finishedAt)],
      );
      await client.query(
        `INSERT INTO match_participant
        SELECT id,$1,finished_at,0,1 FROM game_match WHERE id IN
          (SELECT md5('history-plan-'||n)::uuid FROM generate_series(1,2000) n)`,
        [player],
      );
      await client.query('ANALYZE match_participant');
      const plan = await client.query(
        'EXPLAIN (FORMAT JSON) SELECT match_id,finished_at,final_score_units,final_rank FROM match_participant WHERE player_id=$1 ORDER BY finished_at DESC,match_id DESC LIMIT 21',
        [player],
      );
      assert.match(JSON.stringify(plan.rows[0]['QUERY PLAN']), /match_participant_history/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  },
);

test(
  'real History pagination tolerates new and late commits without claiming a frozen snapshot',
  integration,
  async (t) => {
    const f = await fixture(t),
      result = completedResult(f.players.slice(0, 3));
    const ids = Array.from({ length: 3 }, () => randomUUID())
      .sort()
      .reverse();
    for (const matchId of ids) await f.writer.save({ ...result, matchId });
    const page = await f.reader.listForPlayer(f.players[0]!, { limit: 1 });
    const newer = { ...result, matchId: randomUUID(), finishedAt: result.finishedAt + 10 };
    await f.writer.save(newer);
    const next = await f.reader.listForPlayer(
      f.players[0]!,
      historyPage({ cursor: page.nextCursor }),
    );
    assert.deepEqual(
      next.items.map((i) => i.matchId),
      ids.slice(1),
    );
    const late = { ...result, matchId: randomUUID(), finishedAt: result.finishedAt + 5 };
    await f.writer.save(late);
    const refreshed = await f.reader.listForPlayer(f.players[0]!, { limit: 20 });
    assert.deepEqual(
      refreshed.items.slice(0, 2).map((i) => i.matchId),
      [newer.matchId, late.matchId],
    );
    const absentAnchor = encodeHistoryCursor({
      finishedAt: new Date(result.finishedAt + 1).toISOString(),
      matchId: randomUUID(),
    });
    assert.equal(
      (await f.reader.listForPlayer(f.players[0]!, historyPage({ cursor: absentAnchor }))).items
        .length,
      3,
    );
  },
);

test(
  'real History detail is participation-authorized, viewer-private, ordered and uses current names',
  integration,
  async (t) => {
    const f = await fixture(t),
      result = completedResult(f.players.slice(0, 3));
    await f.writer.save(result);
    const own = await f.reader.findDetailForPlayer(f.players[2]!, result.matchId);
    assert.ok(own);
    assert.equal(own.questions.length, 10);
    assert.deepEqual(
      own.questions.map((q) => q.questionNumber),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.equal(own.questions.filter((q) => q.ownResult.selectedChoiceId === null).length, 5);
    for (const [index, q] of own.questions.entries()) {
      const source = result.resolvedQuestions[index]!;
      assert.deepEqual(
        q.choices,
        source.question.choices.map((c) => ({ choiceId: c.id, text: c.text })),
      );
      assert.equal(q.correctChoiceId, source.question.correctChoiceId);
      assert.deepEqual(Object.keys(q.ownResult), [
        'selectedChoiceId',
        'attemptCount',
        'finalAnsweredMs',
        'score',
      ]);
      assert.equal(q.ownResult.score.scoreUnits, '0');
    }
    assert.deepEqual(Object.keys(own), ['match', 'participants', 'questions']);
    assert.deepEqual(Object.keys(own.participants[0]!), [
      'playerId',
      'displayName',
      'score',
      'rank',
    ]);
    assert.deepEqual(
      own.participants.map((p) => p.rank),
      [1, 1, 3],
    );
    assert.equal(own.match.finishedAt, new Date(result.finishedAt).toISOString());
    await f.pool.query('UPDATE player SET display_name=$1 WHERE id=$2', [
      'Renamed Nguyễn 👩‍💻',
      f.players[0],
    ]);
    const renamed = await f.reader.findDetailForPlayer(f.players[2]!, result.matchId);
    assert.equal(
      renamed!.participants.find((p) => p.playerId === f.players[0])!.displayName,
      'Renamed Nguyễn 👩‍💻',
    );
    assert.deepEqual(renamed!.questions, own.questions);
    assert.equal(await f.reader.findDetailForPlayer(f.players[3]!, result.matchId), null);
    assert.equal(await f.reader.findDetailForPlayer(f.players[0]!, randomUUID()), null);
    const http = await httpFixture(t, f.reader);
    const token = await http.auth.sessions.create({ id: f.players[3]!, displayName: 'Other' });
    const denied = await http.server.inject({
      url: `/history/${result.matchId}`,
      headers: { cookie: `trivia_session=${token}` },
    });
    const absent = await http.server.inject({
      url: `/history/${randomUUID()}`,
      headers: { cookie: `trivia_session=${token}` },
    });
    const unpersisted = completedResult(f.players.slice(0, 3));
    const missing = await http.server.inject({
      url: `/history/${unpersisted.matchId}`,
      headers: { cookie: `trivia_session=${token}` },
    });
    assert.equal(denied.statusCode, 404);
    assert.equal(denied.body, absent.body);
    assert.equal(denied.body, missing.body);
  },
);

test(
  'real History never observes an uncommitted completion, then sees the entire commit',
  integration,
  async (t) => {
    const f = await fixture(t),
      result = completedResult(f.players.slice(0, 3));
    const entered = deferred<void>(),
      release = deferred<void>();
    t.after(() => release.resolve());
    const held = new CompletedMatchRepository({
      connect: async () => {
        const client = await f.pool.connect();
        return new Proxy(client, {
          get(target, key) {
            if (key === 'query')
              return async (sql: string, values?: unknown[]) => {
                if (sql === 'COMMIT') {
                  entered.resolve();
                  await release.promise;
                }
                return target.query(sql, values);
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    });
    const pending = held.save(result);
    await entered.promise;
    assert.deepEqual(await f.reader.listForPlayer(f.players[0]!, { limit: 20 }), empty);
    assert.equal(await f.reader.findDetailForPlayer(f.players[0]!, result.matchId), null);
    release.resolve();
    await pending;
    assert.equal((await f.reader.listForPlayer(f.players[0]!, { limit: 20 })).items.length, 1);
    assert.equal(
      (await f.reader.findDetailForPlayer(f.players[0]!, result.matchId))!.questions.length,
      10,
    );
  },
);

for (const fault of ['missing-answer', 'contradictory-total', 'missing-profile'] as const) {
  test(`real History rejects ${fault} without returning partial detail`, integration, async (t) => {
    const f = await fixture(t),
      result = completedResult(f.players.slice(0, 3));
    await f.writer.save(result);
    if (fault === 'missing-answer')
      await f.pool.query(
        'DELETE FROM match_answer_snapshot WHERE match_id=$1 AND player_id=$2 AND question_position=1',
        [result.matchId, f.players[0]],
      );
    else if (fault === 'contradictory-total')
      await f.pool.query(
        'UPDATE match_participant SET final_score_units=final_score_units+1 WHERE match_id=$1 AND player_id=$2',
        [result.matchId, f.players[0]],
      );
    else {
      // Disposable schema only: simulate external corruption impossible through normal FK-enforced writes.
      const client = await f.pool.connect();
      try {
        await client.query("SET session_replication_role='replica'");
        await client.query('DELETE FROM player WHERE id=$1', [f.players[0]]);
      } finally {
        await client.query("SET session_replication_role='origin'");
        client.release();
      }
    }
    await assert.rejects(
      f.reader.findDetailForPlayer(f.players[0]!, result.matchId),
      /HISTORY_INTEGRITY_FAILURE/,
    );
    const http = await httpFixture(t, f.reader);
    const token = await http.auth.sessions.create({ id: f.players[0]!, displayName: 'Fixture' });
    const response = await http.server.inject({
      url: `/history/${result.matchId}`,
      headers: { cookie: `trivia_session=${token}` },
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { code: 'INTERNAL_ERROR' });
  });
}

test('History read failures release clients and hide driver secrets', async () => {
  let released = 0;
  const reader = new HistoryRepository({
    connect: async () =>
      ({
        query: async () => {
          throw Error('PRIVATE_DB_SECRET');
        },
        release: () => {
          released++;
        },
      }) as unknown as pg.PoolClient,
  });
  await assert.rejects(
    reader.listForPlayer(fixturePlayer.id, { limit: 20 }),
    /HISTORY_UNAVAILABLE/,
  );
  await assert.rejects(
    reader.findDetailForPlayer(fixturePlayer.id, randomUUID()),
    /HISTORY_UNAVAILABLE/,
  );
  assert.equal(released, 2);
  const disconnected = new HistoryRepository({
    connect: async () => {
      throw Error('PRIVATE_PASSWORD');
    },
  });
  await assert.rejects(
    disconnected.listForPlayer(fixturePlayer.id, { limit: 20 }),
    (e) => e instanceof HistoryError && !e.message.includes('PRIVATE'),
  );
});

test('History repository binds bounded pagination values and authorizes before any private reads', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const reader = new HistoryRepository({
    connect: async () =>
      ({
        query: async (sql: string, values: unknown[]) => {
          calls.push({ sql, values });
          return { rows: [] };
        },
        release: () => {},
      }) as unknown as pg.PoolClient,
  });
  await reader.listForPlayer(fixturePlayer.id, { limit: 50 });
  assert.deepEqual(calls[0]!.values, [fixturePlayer.id, 51]);
  assert.match(calls[0]!.sql, /ORDER BY finished_at DESC,match_id DESC LIMIT \$2/);
  const cursor = { finishedAt: '2026-11-09T01:00:00.000Z', matchId: randomUUID() };
  await reader.listForPlayer(fixturePlayer.id, { limit: 1, cursor });
  assert.deepEqual(calls[1]!.values, [fixturePlayer.id, cursor.finishedAt, cursor.matchId, 2]);
  const before = calls.length;
  assert.equal(await reader.findDetailForPlayer(fixturePlayer.id, randomUUID()), null);
  assert.equal(calls.length, before + 1);
  assert.match(calls.at(-1)!.sql, /own.player_id=\$1/);
  await assert.rejects(
    reader.findDetailForPlayer(fixturePlayer.id, "'; DROP TABLE player;--"),
    /Invalid History input/,
  );
});

test('History Detail expiry and server closure during SQL prevent later private delivery', async (t) => {
  for (const closing of [false, true]) {
    const waiting = deferred<null>(),
      entered = deferred<void>();
    const f = await httpFixture(t, {
      listForPlayer: async () => empty,
      findDetailForPlayer: async () => {
        entered.resolve();
        return waiting.promise;
      },
    });
    const address = await f.server.listen({ host: '127.0.0.1', port: 0 });
    const response = fetch(`${address}/%68istory/${randomUUID()}`, {
      headers: { Cookie: f.cookie },
    });
    await entered.promise;
    let shutdown: Promise<void> | undefined;
    if (closing) {
      const closed = deferred<void>();
      const closeSessions = f.auth.sessions.close.bind(f.auth.sessions);
      f.auth.sessions.close = async () => {
        await closeSessions();
        closed.resolve();
      };
      shutdown = f.server.close();
      // preClose invalidates sessions before HTTP drains, without awaiting SQL.
      await closed.promise;
    } else f.setTime(idleMs);
    waiting.resolve(null);
    assert.equal((await response).status, 401);
    await shutdown;
  }
});

test(
  'real History preserves BIGINT precision beyond safe numbers without treating SQL stress as legal M1 scoring',
  integration,
  async (t) => {
    const f = await fixture(t),
      result = completedResult(f.players.slice(0, 3));
    await f.writer.save(result);
    const extra = 9007199254740993n;
    await f.pool.query(
      'UPDATE match_answer_snapshot SET question_score_units=question_score_units+$1 WHERE match_id=$2 AND player_id=$3 AND question_position=1',
      [extra.toString(), result.matchId, f.players[0]],
    );
    await f.pool.query(
      'UPDATE match_participant SET final_score_units=final_score_units+$1 WHERE match_id=$2 AND player_id=$3',
      [extra.toString(), result.matchId, f.players[0]],
    );
    await f.pool.query(
      'UPDATE match_participant SET final_rank=2 WHERE match_id=$1 AND player_id=$2',
      [result.matchId, f.players[1]],
    );
    const expected = (result.participants[0]!.finalScoreUnits + extra).toString();
    assert.equal(
      (await f.reader.listForPlayer(f.players[0]!, { limit: 20 })).items[0]!.ownResult.score
        .scoreUnits,
      expected,
    );
    const detail = await f.reader.findDetailForPlayer(f.players[0]!, result.matchId);
    assert.equal(
      detail!.participants.find((p) => p.playerId === f.players[0])!.score.scoreUnits,
      expected,
    );
    assert.equal(
      detail!.questions[0]!.ownResult.score.scoreUnits,
      (result.resolvedQuestions[0]!.results[0]!.questionScoreUnits + extra).toString(),
    );
  },
);

test('real PostgreSQL connection failure maps to safe History 503', integration, async (t) => {
  const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }).database;
  const pool = new pg.Pool({ ...config, port: 1, connectionTimeoutMillis: 100 });
  t.after(() => pool.end());
  const f = await httpFixture(t, new HistoryRepository(pool));
  const response = await f.server.inject({ url: '/history', headers: { cookie: f.cookie } });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { code: 'HISTORY_UNAVAILABLE' });
  assert.doesNotMatch(f.logs.join(''), /password|ECONNREFUSED|127\.0\.0\.1/);
});

test(
  'real concurrent completions remain isolated in History and private SQL always filters the viewer',
  integration,
  async (t) => {
    const f = await fixture(t);
    const a = completedResult(f.players.slice(0, 3)),
      b = completedResult(f.players.slice(1));
    await Promise.all([f.writer.save(a), f.writer.save(b)]);
    const sql: string[] = [];
    const reader = new HistoryRepository({
      connect: async () => {
        const client = await f.pool.connect();
        return new Proxy(client, {
          get(target, key) {
            if (key === 'query')
              return (text: string, values: unknown[]) => {
                sql.push(text);
                if (text.includes('FROM match_answer_snapshot'))
                  assert.deepEqual(values, [a.matchId, f.players[0]]);
                return target.query(text, values);
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    });
    assert.equal(
      (await reader.findDetailForPlayer(f.players[0]!, a.matchId))!.match.matchId,
      a.matchId,
    );
    assert.ok(
      sql.find((s) => s.includes('FROM match_answer_snapshot'))!.includes('AND player_id=$2'),
    );
    assert.deepEqual(
      (await f.reader.listForPlayer(f.players[0]!, { limit: 20 })).items.map((i) => i.matchId),
      [a.matchId],
    );
    assert.deepEqual(
      (await f.reader.listForPlayer(f.players[3]!, { limit: 20 })).items.map((i) => i.matchId),
      [b.matchId],
    );
  },
);
