import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MatchCompletions } from '../src/application/match-completions.js';
import type { CompletionOutcome } from '../src/application/match-completions.js';
import { CompletionError } from '../src/application/completed-match.js';
import { MatchCoordinator } from '../src/application/match-coordinator.js';
import type { MatchResult } from '../src/domain/match-engine.js';
import { demoQuestions } from '../src/application/demo-questions.js';
import { createServer } from '../src/transport/server.js';
import { testAuth } from './support/auth.js';
import { completedResult } from './support/completed-match.js';

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('completion capture owns immutable reference before SQL, coalesces attempts and retries unconfirmed results explicitly', async () => {
  const first = deferred(),
    second = deferred(),
    result = completedResult();
  const calls: MatchResult[] = [],
    diagnostics: CompletionOutcome[] = [];
  const owner = new MatchCompletions(
    {
      save: (r) => {
        calls.push(r);
        return calls.length === 1 ? first.promise : second.promise;
      },
    },
    (d) => {
      diagnostics.push(d);
    },
  );
  const pending = owner.capture(result);
  assert.equal(calls.length, 0);
  assert.equal(owner.outcome(result.matchId)?.status, 'pending');
  assert.strictEqual(owner.capture(result), pending);
  assert.strictEqual(owner.capture({ ...result, matchId: result.matchId.toUpperCase() }), pending);
  assert.strictEqual(owner.retry(result.matchId), pending);
  await Promise.resolve();
  assert.strictEqual(calls[0], result);
  first.reject(new CompletionError('COMPLETION_UNCONFIRMED'));
  assert.equal((await pending).status, 'unconfirmed');
  assert.strictEqual(owner.capture(result), pending);
  assert.equal(calls.length, 1);
  const retry = owner.retry(result.matchId);
  assert.strictEqual(owner.retry(result.matchId), retry);
  second.resolve();
  assert.equal((await retry).status, 'succeeded');
  assert.equal(calls.length, 2);
  assert.strictEqual(calls[1], result);
  assert.strictEqual(owner.retry(result.matchId), retry);
  assert.deepEqual(
    diagnostics.map((d) => d.status),
    ['unconfirmed', 'succeeded'],
  );
  assert.doesNotMatch(JSON.stringify(diagnostics), /question|correctChoice|submission|password/);
  await owner.close();
  assert.throws(() => owner.retry(result.matchId), /closed/);
});

test('completion conflict is terminal; independent Matches proceed and diagnostic rejection is contained', async () => {
  const a = completedResult(),
    b = completedResult();
  let calls = 0;
  const owner = new MatchCompletions(
    {
      save: async (r) => {
        calls++;
        if (r === a) throw new CompletionError('COMPLETION_CONFLICT');
      },
    },
    async () => {
      throw Error('SECRET_DIAGNOSTIC');
    },
  );
  const outcomes = await Promise.all([owner.capture(a), owner.capture(b)]);
  assert.deepEqual(
    outcomes.map((o) => o.status),
    ['failed', 'succeeded'],
  );
  const before = calls;
  await owner.retry(a.matchId);
  assert.equal(calls, before);
  const conflict = { ...b, finishedAt: b.finishedAt + 1 };
  assert.equal((await owner.capture(conflict)).code, 'COMPLETION_CONFLICT');
  assert.equal(owner.outcome(b.matchId)?.status, 'succeeded');
  await new Promise<void>((r) => setImmediate(r));
  await assert.rejects(owner.close(), /COMPLETION_DRAIN_FAILED/);
});

test('unconfirmed timeout diagnostics cannot start a second save while the first is still active', async () => {
  const gate = deferred(),
    result = completedResult();
  let calls = 0;
  const owner = new MatchCompletions({
    save: () => {
      calls++;
      return gate.promise;
    },
  });
  const first = owner.capture(result);
  await Promise.resolve();
  owner.reportPending();
  assert.equal(owner.outcome(result.matchId)?.status, 'unconfirmed');
  assert.strictEqual(owner.retry(result.matchId), first);
  assert.equal(calls, 1);
  gate.resolve();
  assert.equal((await first).status, 'succeeded');
  await owner.close();
});

test('known storage failure can be retried without mutating original completion', async () => {
  const result = completedResult();
  let calls = 0;
  const owner = new MatchCompletions({
    save: async () => {
      if (++calls === 1) throw new CompletionError('COMPLETION_STORAGE_FAILURE');
    },
  });
  assert.equal((await owner.capture(result)).status, 'failed');
  assert.equal((await owner.retry(result.matchId)).status, 'succeeded');
  assert.equal(calls, 2);
  assert.ok(Object.isFrozen(result));
  await owner.close();
});

for (const duringShutdown of [false, true]) {
  test(
    `automatic FINISHED handoff survives ${duringShutdown ? 'Gateway closure and FIFO shutdown drain' : 'normal timer progression'} before Registry cleanup`,
    { timeout: 8_000 },
    async () => {
      let now = 0;
      const tasks: { at: number; callback: () => void }[] = [];
      const clock = { now: () => now },
        scheduler = {
          schedule: (at: number, callback: () => void) => {
            tasks.push({ at, callback });
            return () => {};
          },
        };
      const saved = deferred(),
        captured: MatchResult[] = [];
      const owner = new MatchCompletions({
        save: (r) => {
          captured.push(r);
          return saved.promise;
        },
      });
      const coordinator = new MatchCoordinator(clock, scheduler, randomUUID, () => {}, owner);
      const server = createServer({
        auth: testAuth(),
        lobby: { coordinator, players: { findPlayerById: async () => null } },
        completions: owner,
      });
      await server.listen({ host: '127.0.0.1', port: 0 });
      try {
        const first = coordinator.create(randomUUID(), 'create'),
          host = (await first).outcome;
        assert.ok(host.status === 'accepted');
        const matchId = host.match.id,
          player = host.match.hostPlayerId;
        await coordinator.dispatch(randomUUID(), 'join', { type: 'join', matchId });
        await coordinator.dispatch(player, 'start', {
          type: 'start',
          matchId,
          questions: demoQuestions(),
        });
        for (let n = 0; n < 19; n++) {
          const task = tasks.at(-1)!;
          now = task.at;
          task.callback();
          await coordinator.whenIdle(matchId);
        }
        const last = tasks.at(-1)!;
        now = last.at;
        let closing: Promise<void> | undefined;
        if (duringShutdown) {
          // Same turn: a queued final timeout must execute after ingress has closed.
          coordinator.timeout({
            type: 'reveal-deadline',
            matchId,
            questionId: demoQuestions()[9]!.id,
            deadlineAt: now,
          });
          const draining = coordinator.shutdown();
          closing = server.close();
          await draining;
          assert.equal(coordinator.lookup(matchId).status, 'missing');
        } else {
          last.callback();
          await coordinator.whenIdle(matchId);
          const found = coordinator.lookup(matchId);
          assert.ok(found.status === 'found' && found.match.phase === 'FINISHED');
          assert.strictEqual(captured[0], found.match.result);
        }
        assert.equal(captured.length, 1);
        assert.equal(captured[0]!.resolvedQuestions.length, 10);
        assert.equal(owner.outcome(matchId)?.status, 'pending');
        if (!duringShutdown) assert.strictEqual(coordinator.create(player, 'create'), first);
        else assert.throws(() => coordinator.create(player, 'create'), /closed/);
        saved.resolve();
        if (closing) await closing;
        else await server.close();
        assert.equal(owner.outcome(matchId)?.status, 'succeeded');
      } finally {
        saved.resolve();
        await server.close();
      }
    },
  );
}

test(
  'shutdown watchdog bounds pending SQL and reports unconfirmed completion without a second budget',
  { timeout: 14_000 },
  async () => {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `
    import { runBackend } from './src/main.ts';
    import { readConfig } from './src/config.ts';
    import { createServer } from './src/transport/server.ts';
    import { MatchCompletions } from './src/application/match-completions.ts';
    import { completedResult } from './tests/support/completed-match.ts';
    const owner = new MatchCompletions({save: () => new Promise(() => {})}, (o) => console.log(JSON.stringify(o)));
    owner.capture(completedResult());
    const server = createServer({completions: owner});
    const config = {...readConfig({DATABASE_URL:'postgresql://fixture:fixture@127.0.0.1/unused'}),port:0};
    const db = {query:async()=>({rows:[]}),on:()=>{},off:()=>{},end:async()=>{}};
    server.addHook('onListen', async () => { process.kill(process.pid,'SIGTERM'); });
    await runBackend(config, server, db, owner);
  `,
        ],
        { timeout: 12_500 },
      ),
      (error: unknown) => {
        assert.ok(
          error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 1 &&
            'stdout' in error &&
            'stderr' in error,
        );
        assert.match(String(error.stdout), /COMPLETION_DRAIN_TIMEOUT/);
        assert.match(String(error.stderr), /Backend shutdown exceeded 10 seconds/);
        return true;
      },
    );
  },
);
