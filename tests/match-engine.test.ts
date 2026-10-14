import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  checkStartEligibility,
  createMatch,
  joinMatch,
  leaveMatch,
} from '../src/domain/match-engine.js';
import type { LobbyOutcome, WaitingMatch } from '../src/domain/match-engine.js';

function lobby(): WaitingMatch {
  return createMatch('host', () => 'server-match-id').match;
}

function accepted(outcome: LobbyOutcome): WaitingMatch {
  assert.equal(outcome.status, 'accepted');
  assert.ok(outcome.status === 'accepted');
  assert.equal(outcome.changed, true);
  return outcome.match;
}

function rejected(outcome: LobbyOutcome, match: WaitingMatch, code: string): void {
  assert.deepEqual(outcome, { status: 'rejected', code, match });
  assert.equal(outcome.match, match);
}

test('create establishes a WAITING lobby with server-generated identity, Host and version 1', () => {
  const outcome = createMatch('durable-player-id', randomUUID);
  const match = accepted(outcome);
  assert.match(match.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    { ...match, id: 'generated' },
    {
      id: 'generated',
      hostPlayerId: 'durable-player-id',
      phase: 'WAITING',
      participants: ['durable-player-id'],
      version: 1,
    },
  );
  assert.notEqual(createMatch('durable-player-id', randomUUID).match.id, match.id);
});

test('join and non-Host leave mutate membership once, preserve Host and increment versions', () => {
  const original = lobby();
  const joined = accepted(joinMatch(original, 'player-two'));
  assert.deepEqual(joined.participants, ['host', 'player-two']);
  assert.equal(joined.version, 2);
  assert.deepEqual(original.participants, ['host']);
  const left = accepted(leaveMatch(joined, 'player-two'));
  assert.deepEqual(left, { ...original, version: 3 });
  assert.equal(left.version, 3);
});

test('duplicate joins and repeated leaves reject without changing state or version', () => {
  const match = accepted(joinMatch(lobby(), 'player-two'));
  const before = structuredClone(match);
  rejected(joinMatch(match, 'player-two'), match, 'ALREADY_MATCH_PARTICIPANT');
  rejected(joinMatch(match, 'host'), match, 'ALREADY_MATCH_PARTICIPANT');
  assert.deepEqual(match, before);
  const left = accepted(leaveMatch(match, 'player-two'));
  rejected(leaveMatch(left, 'player-two'), left, 'NOT_MATCH_PARTICIPANT');
  assert.equal(left.version, 3);
});

test('all counts from 2 through 10 permit Host eligibility; an eleventh join rejects', () => {
  let match = lobby();
  for (let count = 2; count <= 10; count++) {
    match = accepted(joinMatch(match, `player-${count}`));
    assert.equal(match.participants.length, count);
    assert.equal(match.version, count);
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.deepEqual(checkStartEligibility(match, 'host'), {
        status: 'accepted',
        changed: false,
        match,
      });
      assert.equal(checkStartEligibility(match, 'host').match, match);
    }
    assert.equal(match.phase, 'WAITING');
    assert.equal(match.version, count);
  }
  const before = structuredClone(match);
  rejected(joinMatch(match, 'eleventh'), match, 'MATCH_FULL');
  rejected(joinMatch(match, 'host'), match, 'ALREADY_MATCH_PARTICIPANT');
  assert.deepEqual(match, before);
  const left = accepted(leaveMatch(match, 'player-5'));
  const replacement = accepted(joinMatch(left, 'replacement'));
  assert.equal(replacement.participants.length, 10);
  assert.equal(replacement.version, 12);
});

test('eligibility uses current membership and count, and requires the Host', () => {
  const original = lobby();
  rejected(checkStartEligibility(original, 'host'), original, 'INSUFFICIENT_PARTICIPANTS');
  rejected(checkStartEligibility(original, 'outsider'), original, 'NOT_MATCH_PARTICIPANT');
  rejected(leaveMatch(original, 'outsider'), original, 'NOT_MATCH_PARTICIPANT');
  const joined = accepted(joinMatch(original, 'player-two'));
  rejected(checkStartEligibility(joined, 'player-two'), joined, 'NOT_HOST');
  const left = accepted(leaveMatch(joined, 'player-two'));
  rejected(checkStartEligibility(left, 'host'), left, 'INSUFFICIENT_PARTICIPANTS');
  assert.equal(left.version, 3);
});

test('Host departure is explicitly unsupported and does not select a departure policy', () => {
  const match = accepted(joinMatch(lobby(), 'player-two'));
  const before = structuredClone(match);
  assert.deepEqual(leaveMatch(match, 'host'), {
    status: 'unsupported',
    reason: 'HOST_DEPARTURE_DEFERRED',
    match,
  });
  assert.equal(leaveMatch(match, 'host').match, match);
  assert.deepEqual(match, before);
});

for (const phase of ['QUESTION_OPEN', 'REVEAL', 'FINISHED']) {
  test(`lobby operations reject ${phase} without mutation`, () => {
    // Phase 1 cannot create these states; this verifies rejection of an incompatible internal input.
    const match = { ...lobby(), phase } as unknown as WaitingMatch;
    const before = structuredClone(match);
    const code = phase === 'FINISHED' ? 'MATCH_FINISHED' : 'INVALID_MATCH_PHASE';
    rejected(joinMatch(match, 'player-two'), match, code);
    rejected(leaveMatch(match, 'host'), match, code);
    rejected(checkStartEligibility(match, 'host'), match, code);
    assert.deepEqual(match, before);
  });
}

test('invalid trusted identities fail before mutation; identity values remain opaque', () => {
  const match = lobby();
  const before = structuredClone(match);
  for (const identity of ['', ' \t', undefined as unknown as string]) {
    assert.throws(
      () =>
        createMatch(identity, () => {
          throw new Error('must not generate');
        }),
      TypeError,
    );
    assert.throws(() => createMatch('host', () => identity), TypeError);
    for (const command of [joinMatch, leaveMatch, checkStartEligibility]) {
      assert.throws(() => command(match, identity), TypeError);
    }
  }
  assert.deepEqual(match, before);
  assert.deepEqual(accepted(joinMatch(match, ' opaque/id ')).participants, ['host', ' opaque/id ']);
});

test('corrupt internal WAITING state fails as an invariant violation without mutation', () => {
  const valid = lobby();
  const invalidStates: WaitingMatch[] = [
    { ...valid, participants: [] },
    { ...valid, participants: ['other'] },
    { ...valid, participants: ['host', 'host'] },
    { ...valid, participants: ['host', ...Array.from({ length: 10 }, (_, i) => `player-${i}`)] },
    { ...valid, version: 0 },
  ];
  for (const match of invalidStates) {
    const before = structuredClone(match);
    for (const command of [joinMatch, leaveMatch, checkStartEligibility]) {
      assert.throws(() => command(match, 'host'), /Invalid WAITING Match invariant/);
    }
    assert.deepEqual(match, before);
  }
});

test('engine results cannot be mutated by callers', () => {
  const match = accepted(joinMatch(lobby(), 'player-two'));
  assert.throws(() => {
    (match.participants as string[]).push('outsider');
  }, TypeError);
  assert.throws(() => {
    (match as { version: number }).version = 100;
  }, TypeError);
  assert.deepEqual(match.participants, ['host', 'player-two']);
  assert.equal(match.version, 2);
});
