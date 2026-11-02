import assert from 'node:assert/strict';
import test from 'node:test';
import { MemorySessionStore, idleMs, absoluteMs } from '../src/application/sessions.js';
import { fixturePlayer } from './support/auth.js';

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
