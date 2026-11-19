import assert from 'node:assert/strict';
import test from 'node:test';
import { MemorySessionStore, idleMs, absoluteMs } from '../src/application/sessions.js';
import { fixturePlayer } from './support/auth.js';

for (const boundary of ['idle', 'absolute', 'coincident'] as const) {
  for (const offset of [-1, 0, 1]) {
    for (const timerFirst of [false, true]) {
      test(`${boundary} boundary at ${offset} ms, timer first: ${timerFirst}`, async () => {
        const { store, set, fire, tasks } = setup();
        const token = await store.create(fixturePlayer);
        let invalidations = 0;
        const unwatch = await store.watch(token, () => {
          invalidations++;
          unwatch?.();
        });
        const deadline = boundary === 'idle' ? idleMs : absoluteMs;
        if (boundary !== 'idle') {
          for (let time = idleMs - 1; time < absoluteMs - idleMs; time += idleMs - 1) {
            set(time);
            assert.ok(await store.act(token, () => true));
          }
          set(absoluteMs - idleMs);
          assert.ok(await store.act(token, () => true)); // Deadlines coincide.
          if (boundary === 'absolute') {
            set(absoluteMs - 2);
            assert.ok(await store.act(token, () => true)); // Absolute still wins.
          }
          assert.deepEqual(
            [...tasks].map((task) => task.at),
            [absoluteMs],
          );
        }
        const [originalTimer] = tasks;
        set(deadline + offset);
        if (timerFirst) fire();
        // Admission and profile both check the monotonic deadline even if the timer is late.
        assert.equal(!!(await store.act(token, () => true)), offset < 0);
        assert.equal(!!(await store.resolve(token)), offset < 0);
        if (offset < 0) set(boundary === 'idle' ? idleMs * 2 - 1 : absoluteMs);
        fire();
        originalTimer!.callback();
        await store.revoke(token);
        assert.equal(await store.resolve(token), null);
        assert.equal(await store.watch(token, () => assert.fail('Expired session watched')), null);
        assert.equal(invalidations, 1);
        assert.equal(tasks.size, 0);
        await store.close();
      });
    }
  }
}

function setup() {
  let time = 0;
  const tasks = new Set<{ at: number; callback: (error?: unknown) => void }>();
  const store = new MemorySessionStore(
    { now: () => time },
    {
      schedule(at, callback) {
        const task = { at, callback };
        tasks.add(task);
        return () => {
          tasks.delete(task);
        };
      },
    },
  );
  return {
    store,
    tasks,
    set: (value: number) => {
      time = value;
    },
    fire: () => {
      for (const task of [...tasks])
        if (task.at <= time) {
          tasks.delete(task);
          task.callback();
        }
    },
  };
}
test('opaque independent sessions resolve public immutable identity, revoke separately and disappear on restart', async () => {
  const { store, tasks } = setup();
  const first = await store.create(fixturePlayer),
    second = await store.create(fixturePlayer);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.deepEqual(await store.resolve(first), fixturePlayer);
  assert.ok(Object.isFrozen(await store.resolve(first)));
  await store.revoke(first);
  assert.equal(await store.resolve(first), null);
  assert.deepEqual(await store.resolve(second), fixturePlayer);
  assert.equal(await setup().store.resolve(second), null);
  await store.close();
  assert.equal(tasks.size, 0);
  assert.equal(await store.resolve(second), null);
  await assert.rejects(store.create(fixturePlayer));
});
test('profile/heartbeat lookup never refreshes idle; exact deadline expires and cleanup notifies sockets', async () => {
  const { store, set, fire, tasks } = setup();
  const token = await store.create(fixturePlayer);
  let invalidated = 0;
  await store.watch(token, () => invalidated++);
  set(idleMs - 1);
  assert.ok(await store.resolve(token));
  set(idleMs);
  fire();
  assert.equal(await store.resolve(token), null);
  assert.equal(invalidated, 1);
  assert.equal(tasks.size, 0);
  await store.close();
});
test('intentional action refreshes idle without yielding; later revoke cannot cancel admitted work', async () => {
  const { store, set } = setup();
  const token = await store.create(fixturePlayer);
  set(idleMs - 1);
  let admitted = false;
  const operation = store.act(token, (player) => {
    assert.equal(player.id, fixturePlayer.id);
    admitted = true;
    return 'domain-rejected';
  });
  assert.equal(admitted, true);
  await store.revoke(token);
  assert.deepEqual(await operation, { value: 'domain-rejected' });
  assert.equal(await store.act(token, () => assert.fail()), null);
  await store.close();
});
test('intentional activity slides idle but never exceeds absolute twelve hours', async () => {
  const { store, set } = setup();
  const token = await store.create(fixturePlayer);
  for (let now = idleMs - 1; now < absoluteMs; now += idleMs - 1) {
    set(now);
    assert.ok(await store.act(token, () => true));
  }
  set(absoluteMs - 1);
  assert.ok(await store.resolve(token));
  set(absoluteMs);
  assert.equal(await store.act(token, () => assert.fail()), null);
  await store.close();
});

test('inspect authorizes and invokes delivery without yielding or refreshing idle', async () => {
  const { store, set } = setup();
  const token = await store.create(fixturePlayer);
  set(idleMs - 1);
  let delivered = false;
  const inspection = store.inspect(token, (player) => {
    assert.equal(player.id, fixturePlayer.id);
    delivered = true;
    return 'delivered';
  });
  assert.equal(delivered, true);
  assert.deepEqual(await inspection, { value: 'delivered' });
  set(idleMs);
  assert.equal(await store.inspect(token, () => assert.fail()), null);
  await store.close();
});

test('work admitted one millisecond before absolute expiry may settle after socket cleanup', async () => {
  const { store, set, fire, tasks } = setup();
  const token = await store.create(fixturePlayer);
  let closes = 0;
  await store.watch(token, () => closes++);
  for (let time = idleMs - 1; time < absoluteMs - 1; time += idleMs - 1) {
    set(time);
    assert.ok(await store.act(token, () => true));
  }
  let complete!: (receipt: string) => void;
  set(absoluteMs - 1);
  const admitted = await store.act(token, () => {
    return new Promise<string>((resolve) => {
      complete = resolve;
    });
  });
  assert.ok(admitted);
  const [timer] = tasks;
  set(absoluteMs);
  assert.equal(await store.resolve(token), null); // Profile wins the race against the timer.
  fire();
  timer!.callback();
  assert.equal(await store.act(token, () => assert.fail('Expired command admitted')), null);
  complete('accepted');
  assert.equal(await admitted.value, 'accepted');
  assert.equal(closes, 1);
  assert.equal(await store.resolve(token), null);
  await store.close();
});
