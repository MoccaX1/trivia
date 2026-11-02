import assert from 'node:assert/strict';
import test from 'node:test';
import { LoginService } from '../src/application/login.js';
import { canonicalUsername, validateDisplayName } from '../src/application/player-identity.js';
import { fixturePlayer } from './support/auth.js';

test('ASCII canonical identity and Unicode display names validate without mutation', () => {
  assert.equal(canonicalUsername('X'.repeat(128)), 'x'.repeat(128));
  for (const username of ['Alice', 'alice', 'ALICE'])
    assert.equal(canonicalUsername(username), 'alice');
  for (const name of ['', ' alice', 'alice ', 'é', 'a@b', 'a\n', 'x'.repeat(129)])
    assert.throws(() => canonicalUsername(name));
  for (const name of ['Đặng Thị Ánh', ' Alice ', '👩‍👩‍👧‍👦'.repeat(64), 'a\u0301'.repeat(64)])
    validateDisplayName(name);
  for (const name of ['', '  ', '\n', 'a\u0000', 'a\u202e', 'x'.repeat(65), '👩‍👩‍👧‍👦'.repeat(65)])
    assert.throws(() => validateDisplayName(name));
});
test('username failure window is canonical, includes nonexistent users and keeps history after success', async (t) => {
  let now = 0,
    correct = false,
    calls = 0;
  const service = new LoginService(
    {
      findCredentialByUsername: async (username) => {
        assert.equal(username, 'alice');
        return correct ? { player: fixturePlayer, passwordHash: 'fake' } : null;
      },
    },
    () => now,
    async () => {
      calls++;
      return true;
    },
  );
  t.after(() => service.close());
  for (let n = 0; n < 9; n++)
    assert.equal(
      (await service.login('ip', n % 2 ? 'Alice' : 'ALICE', 'password')).status,
      'invalid_credentials',
    );
  correct = true;
  assert.equal((await service.login('ip', 'Alice', 'password')).status, 'authenticated');
  correct = false;
  assert.equal((await service.login('ip', 'alice', 'password')).status, 'invalid_credentials');
  assert.equal((await service.login('other-ip', 'ALICE', 'password')).status, 'rate_limited');
  assert.equal(calls, 11);
  now = 900_000;
  assert.equal((await service.login('ip', 'alice', 'password')).status, 'invalid_credentials');
});
test('IP window counts successes, ignores arbitrary forwarded identity and expires exactly at fifteen minutes', async (t) => {
  let now = 0;
  const service = new LoginService(
    { findCredentialByUsername: async () => ({ player: fixturePlayer, passwordHash: 'fake' }) },
    () => now,
    async () => true,
  );
  t.after(() => service.close());
  for (let n = 0; n < 60; n++)
    assert.equal((await service.login('ip', `user${n}`, 'p')).status, 'authenticated');
  assert.equal((await service.login('ip', 'newuser', 'p')).status, 'rate_limited');
  now = 899_999;
  assert.equal((await service.login('ip', 'newuser', 'p')).status, 'rate_limited');
  now++;
  assert.equal((await service.login('ip', 'newuser', 'p')).status, 'authenticated');
});
test('four concurrent verifications saturate immediately and failures release capacity', async (t) => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new LoginService(
    { findCredentialByUsername: async () => ({ player: fixturePlayer, passwordHash: 'fake' }) },
    () => 0,
    async () => {
      await barrier;
      return true;
    },
  );
  t.after(() => service.close());
  const pending = Array.from({ length: 4 }, () => service.login('ip', 'alice', 'p'));
  assert.equal((await service.login('ip', 'alice', 'p')).status, 'busy');
  release();
  assert.ok((await Promise.all(pending)).every((result) => result.status === 'authenticated'));
  assert.equal((await service.login('ip', 'alice', 'p')).status, 'authenticated');
});
test('database outages propagate and never consume username credential-failure budget', async (t) => {
  const service = new LoginService(
    {
      findCredentialByUsername: async () => {
        throw new Error('private database details');
      },
    },
    () => 0,
  );
  t.after(() => service.close());
  for (let n = 0; n < 12; n++) await assert.rejects(service.login('ip', 'alice', 'p'));
});
