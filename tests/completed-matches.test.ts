import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import pg from 'pg';
import { readConfig } from '../src/config.js';
import { connectPostgres } from '../src/persistence/postgres.js';
import { applyMigrations } from '../src/persistence/migrations.js';
import {
  CompletedMatchRepository,
  readDurableMatch,
} from '../src/persistence/completed-matches.js';
import { CompletionError, durableMatch } from '../src/application/completed-match.js';
import { completedResult } from './support/completed-match.js';

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
function copyResult(result: ReturnType<typeof completedResult>) {
  return structuredClone(result) as Mutable<typeof result>;
}

async function fixture(t: TestContext) {
  const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! }).database;
  const base = connectPostgres(config);
  assert.match((await base.query('SELECT current_database() AS name')).rows[0].name, /_test$/);
  const schema = 'completion_' + randomUUID().replaceAll('-', '');
  await base.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...config, options: `-c search_path=${schema}`, max: 5 });
  t.after(async () => {
    await pool.end();
    await base.query(`DROP SCHEMA ${schema} CASCADE`);
    await base.end();
  });
  const applied = await applyMigrations(pool);
  assert.ok(applied.includes('003_completed_matches.sql'));
  assert.deepEqual(await applyMigrations(pool), []);
  const result = completedResult();
  for (const p of result.participants)
    await pool.query('INSERT INTO player(id,display_name) VALUES($1,$2)', [
      p.playerId,
      'Trusted fixture',
    ]);
  const read = async () => {
    const client = await pool.connect();
    try {
      return await readDurableMatch(client, result.matchId);
    } finally {
      client.release();
    }
  };
  return { pool, result, read, repository: new CompletedMatchRepository(pool) };
}

// Only SQL protocol calls are intercepted; all transactions/constraints remain real PostgreSQL.
function intercepted(
  pool: pg.Pool,
  hook: (sql: string, run: () => Promise<pg.QueryResult>) => Promise<pg.QueryResult>,
) {
  return {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, key) {
          if (key === 'query')
            return (sql: string, values?: unknown[]) => hook(sql, () => target.query(sql, values));
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}
const integration = { skip: !process.env.TEST_DATABASE_URL, timeout: 15_000 };

test('completed storage validates UUIDs, history, ranks, scores and timestamps before SQL', async () => {
  const result = completedResult();
  let connects = 0;
  const repository = new CompletedMatchRepository({
    connect: async () => {
      connects++;
      throw Error('must not connect');
    },
  } as Pick<pg.Pool, 'connect'>);
  for (const invalid of [
    { ...result, matchId: 'opaque-not-uuid' },
    { ...result, finishedAt: result.startedAt },
    { ...result, resolvedQuestions: result.resolvedQuestions.slice(1) },
    { ...result, participants: result.participants.map((p) => ({ ...p, finalRank: 1 })) },
    {
      ...result,
      participants: result.participants.map((p) => ({
        ...p,
        finalScoreUnits: p.finalScoreUnits + 1n,
      })),
    },
  ])
    await assert.rejects(
      repository.save(invalid),
      (e: unknown) => e instanceof CompletionError && e.code === 'INVALID_COMPLETION',
    );
  assert.equal(connects, 0);
  const unavailable = new CompletedMatchRepository({
    connect: async () => {
      throw Error('SECRET_DATABASE_URL');
    },
  } as Pick<pg.Pool, 'connect'>);
  await assert.rejects(unavailable.save(result), /^Error: COMPLETION_STORAGE_FAILURE$/);
});

test(
  'real completion graph round-trips exact facts across fresh connections and identical retries',
  integration,
  async (t) => {
    const f = await fixture(t);
    await Promise.all(Array.from({ length: 3 }, () => f.repository.save(f.result)));
    assert.deepEqual(await f.read(), durableMatch(f.result));
    await f.repository.save(f.result);
    await Promise.all(Array.from({ length: 5 }, () => f.repository.save(f.result)));
    const copy = copyResult(f.result);
    copy.resolvedQuestions[0]!.question.id = 'changed-engine-only-id';
    copy.resolvedQuestions[0]!.question.openedAt += 1;
    await f.repository.save(copy);
    assert.equal(
      (await f.pool.query('SELECT count(*) FROM match_answer_snapshot')).rows[0].count,
      '30',
    );
    assert.equal(
      (await f.pool.query('SELECT count(*) FROM match_question_choice_snapshot')).rows[0].count,
      '40',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*) FROM match_answer_snapshot WHERE selected_choice_key IS NULL',
        )
      ).rows[0].count,
      '5',
    );
    assert.deepEqual(
      (await f.read())!.participants.map((p) => p.rank),
      durableMatch(f.result).participants.map((p) => p.rank),
    );
  },
);

test(
  'real duplicate/conflicting races compare every durable question/choice/result fact',
  integration,
  async (t) => {
    const f = await fixture(t),
      changed = copyResult(f.result);
    changed.resolvedQuestions[0]!.question.text = 'Different authoritative text';
    const raced = await Promise.allSettled([
      f.repository.save(f.result),
      f.repository.save(changed),
    ]);
    assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = raced.find((r) => r.status === 'rejected');
    assert.ok(
      rejected?.status === 'rejected' &&
        rejected.reason instanceof CompletionError &&
        rejected.reason.code === 'COMPLETION_CONFLICT',
    );
    const saved = await f.read();
    const winner =
      saved!.questions[0]!.text === f.result.resolvedQuestions[0]!.question.text
        ? f.result
        : changed;
    const conflict = copyResult(winner);
    conflict.resolvedQuestions[1]!.question.choices[0]!.text = 'Changed choice';
    await assert.rejects(f.repository.save(conflict), /COMPLETION_CONFLICT/);
    await f.repository.save(winner);
    assert.deepEqual(await f.read(), durableMatch(winner));
    const changedAwards = completedResult(
      winner.participants.map((p) => p.playerId),
      winner.matchId,
      2,
    );
    await assert.rejects(f.repository.save(changedAwards), /COMPLETION_CONFLICT/);
    const reordered = copyResult(winner);
    reordered.resolvedQuestions[0]!.question.choices.reverse();
    await assert.rejects(f.repository.save(reordered), /COMPLETION_CONFLICT/);
    const laterFinish = { ...winner, finishedAt: winner.finishedAt + 1 };
    await assert.rejects(f.repository.save(laterFinish), /COMPLETION_CONFLICT/);
  },
);

for (const point of ['dependent-row', 'before-commit', 'after-commit'] as const) {
  test(
    `real transaction ${point} failpoint preserves atomicity and safe retry`,
    integration,
    async (t) => {
      const f = await fixture(t);
      let failed = false;
      const repository = new CompletedMatchRepository(
        intercepted(f.pool, async (sql, run) => {
          if (
            !failed &&
            ((point === 'dependent-row' && sql.startsWith('INSERT INTO match_answer')) ||
              (point !== 'dependent-row' && sql === 'COMMIT'))
          ) {
            failed = true;
            if (point === 'after-commit') await run();
            throw Object.assign(
              Error('SECRET_DRIVER_CONTEXT'),
              point === 'after-commit' ? { code: '40003' } : {},
            );
          }
          return run();
        }),
      );
      await assert.rejects(
        repository.save(f.result),
        point === 'dependent-row' ? /COMPLETION_STORAGE_FAILURE/ : /COMPLETION_UNCONFIRMED/,
      );
      assert.deepEqual(await f.read(), point === 'after-commit' ? durableMatch(f.result) : null);
      if (point !== 'after-commit')
        for (const table of [
          'game_match',
          'match_participant',
          'match_question_snapshot',
          'match_question_choice_snapshot',
          'match_answer_snapshot',
        ])
          assert.equal((await f.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
      await repository.save(f.result);
      assert.deepEqual(await f.read(), durableMatch(f.result));
    },
  );
}

test(
  'real uncommitted graph is invisible; missing Player and deferred correct-choice failures roll back',
  integration,
  async (t) => {
    const f = await fixture(t);
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (reached = r));
    const held = new CompletedMatchRepository(
      intercepted(f.pool, async (sql, run) => {
        if (sql === 'COMMIT') {
          reached();
          await gate;
        }
        return run();
      }),
    );
    const saving = held.save(f.result);
    t.after(release);
    await ready;
    assert.equal(await f.read(), null);
    release();
    await saving;
    const missing = completedResult();
    await assert.rejects(f.repository.save(missing), /COMPLETION_STORAGE_FAILURE/);
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE match_question_snapshot SET correct_choice_key=$1 WHERE match_id=$2 AND question_position=1',
        ['invalid', f.result.matchId],
      );
      await assert.rejects(
        client.query('COMMIT'),
        (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === '23503',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    assert.deepEqual(await f.read(), durableMatch(f.result));
  },
);

test(
  'real schema BIGINT round-trip exceeds JS safe integer; source edits do not alter snapshots',
  integration,
  async (t) => {
    const f = await fixture(t);
    await f.repository.save(f.result);
    const edited = copyResult(f.result);
    edited.resolvedQuestions[0]!.question.text = 'source edited';
    assert.equal(
      (await f.read())!.questions[0]!.text,
      f.result.resolvedQuestions[0]!.question.text,
    );
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      const units = '9007199254740993123'; // SQL precision stress only; not a legal M1 awarded score.
      await client.query('UPDATE match_participant SET final_score_units=$1 WHERE match_id=$2', [
        units,
        f.result.matchId,
      ]);
      const graph = await readDurableMatch(client, f.result.matchId);
      assert.ok(
        graph!.participants.every(
          (p) => p.score === units && BigInt(p.score) === 9_007_199_254_740_993_123n,
        ),
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    assert.deepEqual(await f.read(), durableMatch(f.result));
  },
);
