import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Socket } from 'socket.io-client';
import { Session } from '../auth/session.js';
import { MATCH_SOCKET, MatchSession } from './match-session.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
class FakeSocket {
  handlers = new Map<string, (...args: unknown[]) => void>();
  emitted: {
    event: string;
    request: { commandId: string; payload: object };
    ack: (value: unknown) => void;
  }[] = [];
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, handler);
  }
  connect() {
    this.receive('connect');
  }
  disconnect() {
    /* No transport needed. */
  }
  removeAllListeners() {
    this.handlers.clear();
  }
  emit(
    event: string,
    request: { commandId: string; payload: object },
    ack: (value: unknown) => void,
  ) {
    this.emitted.push({ event, request, ack });
  }
  receive(event: string, value?: unknown) {
    this.handlers.get(event)?.(value);
  }
  accept(index = 0, version = 1) {
    const command = this.emitted[index];
    command.ack({
      commandId: command.request.commandId,
      status: 'accepted',
      matchId: id,
      version,
    });
  }
}
function lobby(version = 1, matchId = id) {
  return {
    matchId,
    version,
    phase: 'WAITING',
    state: {
      hostPlayerId: 'a',
      rules: {
        questionCount: 10,
        answerWindowMs: 10000,
        revealDurationMs: 5000,
        allowAnswerChanges: true,
        maxAttempts: 3,
        earlyClose: false,
      },
      participants: [
        { playerId: 'a', displayName: 'Alice' },
        { playerId: 'b', displayName: 'Bob' },
      ],
    },
  };
}
function question(version: number, number = 1, choiceId?: string, attemptCount = 1) {
  return {
    matchId: id,
    version,
    phase: 'QUESTION_OPEN',
    state: {
      questionNumber: number,
      questionCount: 10,
      deadlineAt: '2026-11-20T00:00:00Z',
      question: {
        questionId: 'q' + number,
        text: 'Pick one',
        choices: ['x', 'y', 'z'].map((choiceId) => ({ choiceId, text: choiceId })),
      },
      participants: lobby().state.participants.map((person) => ({
        ...person,
        score: { scoreUnits: '9007199254740993' },
        rank: 1,
      })),
      ownSubmission: choiceId ? { choiceId, attemptCount, finalAnsweredMs: 1 } : undefined,
    },
  };
}
describe('Match Session authoritative lifecycle', () => {
  let socket: FakeSocket;
  let match: MatchSession;
  async function open() {
    const join = match.command('JoinMatch', id);
    socket.accept();
    await join;
    socket.receive('MatchSnapshot', question(4));
  }
  const player = signal<{ id: string; displayName: string } | undefined>({
    id: 'a',
    displayName: 'Alice',
  });
  const state = signal({ status: 'authenticated' });
  let auth: {
    state: typeof state;
    player: typeof player;
    generation: number;
    unauthenticated: ReturnType<typeof vi.fn>;
    revalidate: ReturnType<typeof vi.fn>;
    verification: ReturnType<typeof signal<'pending' | 'unavailable' | undefined>>;
  };
  beforeEach(() => {
    socket = new FakeSocket();
    player.set({ id: 'a', displayName: 'Alice' });
    state.set({ status: 'authenticated' });
    auth = {
      state,
      player,
      generation: 1,
      unauthenticated: vi.fn(),
      revalidate: vi.fn(),
      verification: signal(undefined),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: Session, useValue: auth },
        { provide: MATCH_SOCKET, useValue: () => socket as unknown as Socket },
      ],
    });
    match = TestBed.inject(MatchSession);
    TestBed.tick();
    match.connect();
  });
  afterEach(() => {
    match.clear();
    vi.useRealTimers();
  });
  it('sends exact Create envelope without manufacturing a snapshot', async () => {
    const result = match.command('CreateMatch');
    expect(socket.emitted[0].request.payload).toEqual({});
    expect(socket.emitted[0].event).toBe('CreateMatch');
    socket.accept();
    expect(await result).toBe(id);
    expect(match.snapshot()).toBeUndefined();
  });
  it('buffers a Create snapshot before its ACK', async () => {
    const result = match.command('CreateMatch');
    socket.receive('LobbySnapshot', lobby());
    socket.accept();
    await result;
    expect(match.snapshot()?.state.participants).toHaveLength(2);
  });
  it('sends exact Join payload without optimistic membership', async () => {
    const result = match.command('JoinMatch', id);
    expect(socket.emitted[0].request.payload).toEqual({ matchId: id });
    expect(match.snapshot()).toBeUndefined();
    socket.accept();
    await result;
  });
  it('rejects malformed IDs without trimming or dispatch', async () => {
    await match.command('JoinMatch', ' ' + id);
    expect(socket.emitted).toHaveLength(0);
    expect(match.feedback()).toContain('UUID');
  });
  it('prevents duplicate pending commands', async () => {
    const result = match.command('CreateMatch');
    await match.command('CreateMatch');
    expect(socket.emitted).toHaveLength(1);
    socket.accept();
    await result;
  });
  it('rejects wrong-Match, stale and duplicate versions', async () => {
    const result = match.command('JoinMatch', id);
    socket.accept();
    await result;
    socket.receive('LobbySnapshot', lobby(4));
    socket.receive('LobbySnapshot', lobby(8, other));
    socket.receive('LobbySnapshot', lobby(2));
    socket.receive('LobbySnapshot', { ...lobby(4), state: { participants: [] } });
    expect(match.snapshot()?.version).toBe(4);
    expect(match.feedback()).toBe('Lobby view is up to date.');
  });
  it('ignores malformed snapshots and snapshots without the viewer', async () => {
    const result = match.command('JoinMatch', id);
    socket.accept();
    await result;
    socket.receive('LobbySnapshot', { ...lobby(), version: '3' });
    socket.receive('LobbySnapshot', { ...lobby(), state: { participants: [] } });
    expect(match.snapshot()).toBeUndefined();
  });
  it('uses one version tracker across handoff and retains authorized question data', async () => {
    const result = match.command('JoinMatch', id);
    socket.accept();
    await result;
    socket.receive('LobbySnapshot', lobby(2));
    socket.receive('MatchSnapshot', question(3));
    socket.receive('LobbySnapshot', lobby(2));
    expect(match.snapshot()?.phase).toBe('QUESTION_OPEN');
    expect(match.canStart()).toBe(false);
    expect(match.snapshot()).toEqual(question(3));
  });
  it('rejects malformed higher versions without consuming them and accepts reveal and finished', async () => {
    await open();
    const valid = question(9);
    socket.receive('MatchSnapshot', { ...valid, state: { ...valid.state, deadlineAt: 'bad' } });
    socket.receive('MatchSnapshot', { ...valid, matchId: other });
    socket.receive('MatchSnapshot', {
      ...valid,
      state: { ...valid.state, participants: valid.state.participants.slice(1) },
    });
    expect(match.snapshot()?.version).toBe(4);
    socket.receive('MatchSnapshot', valid);
    socket.receive('MatchSnapshot', question(9, 1, 'x'));
    expect(match.snapshot()).toEqual(valid);
    const reveal = {
      ...valid,
      version: 10,
      phase: 'REVEAL',
      state: {
        ...valid.state,
        question: { ...valid.state.question, correctChoiceId: 'x' },
        revealEndsAt: valid.state.deadlineAt,
        ownResult: { correct: false, attemptCount: 0, questionScore: { scoreUnits: '0' } },
      },
    };
    socket.receive('MatchSnapshot', reveal);
    expect(match.snapshot()).toEqual(reveal);
    const finished = {
      matchId: id,
      version: 50,
      phase: 'FINISHED',
      state: { participants: valid.state.participants },
    };
    socket.receive('MatchSnapshot', finished);
    expect(match.snapshot()).toEqual(finished);
    expect(
      match.snapshot()?.state.participants.map((p) => 'score' in p && [p.rank, p.score]),
    ).toEqual([
      [1, { scoreUnits: '9007199254740993' }],
      [1, { scoreUnits: '9007199254740993' }],
    ]);
  });
  it('keeps receipt acceptance separate from the authoritative answer and allows a deliberate change', async () => {
    await open();
    const first = match.answer(id, 'q1', 'x');
    expect(socket.emitted[1].event).toBe('SubmitAnswer');
    expect(socket.emitted[1].request).toEqual({
      commandId: expect.any(String),
      payload: { matchId: id, questionId: 'q1', choiceId: 'x' },
    });
    await match.answer(id, 'q1', 'x');
    expect(socket.emitted).toHaveLength(2);
    socket.accept(1, 5);
    await first;
    expect(match.snapshot()).toEqual(question(4));
    expect(match.awaitingAnswerView()).toBe(true);
    expect(match.canAnswer(id, 'x')).toBe(false);
    expect(match.canAnswer(id, 'y')).toBe(true);
    socket.receive('MatchSnapshot', question(5, 1, 'x'));
    expect(match.awaitingAnswerView()).toBe(false);
    const change = match.answer(id, 'q1', 'y');
    expect(socket.emitted[2].request.commandId).not.toBe(socket.emitted[1].request.commandId);
    socket.receive('MatchSnapshot', question(6, 1, 'y', 2));
    expect(match.intent()?.status).toBe('pending'); // Matching selection is not command attribution.
    socket.receive('MatchSnapshot', question(7, 1, 'z', 3));
    socket.accept(2, 6);
    await change;
    expect(match.snapshot()).toEqual(question(7, 1, 'z', 3));
    expect(match.canAnswer(id, 'x')).toBe(false);
  });
  it('uses only snapshots when multiple accepted answer receipts arrive before publication', async () => {
    await open();
    const first = match.answer(id, 'q1', 'x');
    socket.accept(1, 5);
    await first;
    const second = match.answer(id, 'q1', 'y');
    socket.accept(2, 6);
    await second;
    expect(match.snapshot()).toEqual(question(4));
    expect(match.awaitingAnswerView()).toBe(true);
    expect(match.intent()?.commandId).toBe(socket.emitted[2].request.commandId);

    // A delayed view can match the latest intent without establishing its mutation.
    socket.receive('MatchSnapshot', question(5, 1, 'y'));
    expect(match.snapshot()).toEqual(question(5, 1, 'y'));
    expect(match.awaitingAnswerView()).toBe(true);
    expect(match.intent()?.receiptVersion).toBe(6);

    // A coalesced view can reflect a later answer from another session.
    socket.receive('MatchSnapshot', question(7, 1, 'z', 3));
    socket.receive('MatchSnapshot', question(6, 1, 'y', 2));
    socket.accept(1, 5);
    expect(match.snapshot()).toEqual(question(7, 1, 'z', 3));
    expect(match.awaitingAnswerView()).toBe(false);
    expect(match.canAnswer(id, 'x')).toBe(false);
  });
  it('settles a same-choice no-op receipt without waiting for another version', async () => {
    await open();
    const answer = match.answer(id, 'q1', 'x');
    // Another authenticated session confirmed the same choice before this receipt.
    socket.receive('MatchSnapshot', question(5, 1, 'x'));
    socket.accept(1, 5);
    await answer;
    expect(match.awaitingAnswerView()).toBe(false);
    expect(match.canAnswer(id, 'x')).toBe(false);
    expect(match.canAnswer(id, 'y')).toBe(true);
  });
  it('scopes an uncertain retry to the route and dispatch, then retires it at rollover', async () => {
    vi.useFakeTimers();
    await open();
    const first = match.answer(id, 'q1', 'x');
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    expect(match.uncertain()).toBe(true);
    await match.retry(other);
    await match.retry();
    expect(socket.emitted).toHaveLength(2);
    const retry = match.retry(id);
    expect(socket.emitted[2].request).toEqual(socket.emitted[1].request);
    expect(socket.emitted[2].request.payload).toBe(socket.emitted[1].request.payload);
    socket.accept(1, 5);
    expect(match.intent()?.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(5000);
    await retry;
    expect(match.uncertain()).toBe(true);
    socket.receive('MatchSnapshot', question(8, 2));
    expect(match.intent()).toBeUndefined();
    socket.accept(2, 5);
    expect(match.intent()).toBeUndefined();
    expect(match.snapshot()).toEqual(question(8, 2));
    expect(match.canRetry(id)).toBe(false);
    expect(match.canAnswer(id, 'x')).toBe(true);
  });
  it('checks connection, session and question context and still handles current auth failure after rollover', async () => {
    await open();
    auth.verification.set('pending');
    await match.answer(id, 'q1', 'x');
    auth.verification.set(undefined);
    match.connection.set('lost');
    await match.answer(id, 'q1', 'x');
    match.connection.set('connected');
    await match.answer(id, 'old', 'x');
    expect(socket.emitted).toHaveLength(1);
    const answer = match.answer(id, 'q1', 'x');
    socket.receive('MatchSnapshot', question(8, 2));
    await answer;
    const sent = socket.emitted[1];
    sent.ack({
      commandId: sent.request.commandId,
      status: 'error',
      error: { code: 'UNAUTHENTICATED' },
    });
    expect(auth.unauthenticated).toHaveBeenCalledWith(1);
    expect(match.intent()).toBeUndefined();
  });
  it('keeps a confirmed choice when a change is rejected, then retires a pending choice on reveal', async () => {
    await open();
    socket.receive('MatchSnapshot', question(5, 1, 'x'));
    const change = match.answer(id, 'q1', 'y');
    const sent = socket.emitted[1];
    sent.ack({
      commandId: sent.request.commandId,
      matchId: id,
      version: 5,
      status: 'rejected',
      error: { code: 'INVALID_CHOICE' },
    });
    await change;
    expect(match.snapshot()).toEqual(question(5, 1, 'x'));
    expect(match.feedback()).toContain('unavailable for this question');
    const pending = match.answer(id, 'q1', 'z');
    const { state } = question(5);
    socket.receive('MatchSnapshot', {
      matchId: id,
      version: 7,
      phase: 'REVEAL',
      state: {
        questionNumber: 1,
        questionCount: 10,
        participants: state.participants,
        question: { ...state.question, correctChoiceId: 'x' },
        revealEndsAt: state.deadlineAt,
        ownResult: {
          selectedChoiceId: 'x',
          correct: true,
          questionScore: { scoreUnits: '1' },
          attemptCount: 1,
          finalAnsweredMs: 1,
        },
      },
    });
    await pending;
    socket.accept(2, 6);
    expect(match.snapshot()?.phase).toBe('REVEAL');
    expect(match.intent()).toBeUndefined();
    expect(match.feedback()).toBe('');
    expect(match.canRetry(id)).toBe(false);
    expect(match.canAnswer(id, 'z')).toBe(false);
  });
  it('enables Start only for the snapshot Host with two players', async () => {
    const result = match.command('JoinMatch', id);
    socket.accept();
    await result;
    socket.receive('LobbySnapshot', lobby());
    expect(match.canStart()).toBe(true);
    player.set({ id: 'b', displayName: 'Bob' });
    expect(match.canStart()).toBe(false);
    await match.command('StartMatch', id);
    expect(socket.emitted).toHaveLength(1);
  });
  it('accepted Start waits for publication and cannot be repeated', async () => {
    const join = match.command('JoinMatch', id);
    socket.accept();
    await join;
    socket.receive('LobbySnapshot', lobby());
    const start = match.command('StartMatch', id);
    socket.accept(1);
    await start;
    expect(match.snapshot()?.phase).toBe('WAITING');
    await match.command('StartMatch', id);
    expect(socket.emitted).toHaveLength(2);
  });
  it('timeout is uncertain and explicit retry preserves command ID and payload', async () => {
    vi.useFakeTimers();
    const result = match.command('JoinMatch', id);
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(match.uncertain()).toBe(true);
    await match.command('CreateMatch');
    const retry = match.retry();
    expect(socket.emitted[1].request).toEqual(socket.emitted[0].request);
    socket.accept(1);
    await retry;
  });
  it('disconnect marks the view stale without removing membership', async () => {
    const result = match.command('JoinMatch', id);
    socket.accept();
    await result;
    socket.receive('LobbySnapshot', lobby());
    socket.receive('disconnect', 'transport close');
    expect(match.live()).toBe(false);
    expect(match.snapshot()?.state.participants).toHaveLength(2);
    expect(match.feedback()).toContain('does not remove membership');
    expect(match.canStart()).toBe(false);
  });
  it('old ACK cannot restore a cleared session', async () => {
    const result = match.command('CreateMatch');
    match.clear();
    socket.accept();
    await result;
    expect(match.matchId()).toBeUndefined();
    expect(match.snapshot()).toBeUndefined();
  });
  it('a late accepted ACK after expiry cannot restore private Match state', async () => {
    const result = match.command('CreateMatch');
    socket.receive('disconnect');
    expect(await result).toBeUndefined();
    expect(match.uncertain()).toBe(true);
    auth.generation++;
    state.set({ status: 'anonymous' });
    TestBed.tick();
    socket.accept();
    expect(match.matchId()).toBeUndefined();
    expect(match.snapshot()).toBeUndefined();
    expect(match.connection()).toBe('idle');
  });
  it('obsolete authentication rejection cannot invalidate a newer viewer', async () => {
    const result = match.command('CreateMatch');
    auth.generation++;
    socket.emitted[0].ack({
      commandId: socket.emitted[0].request.commandId,
      status: 'error',
      error: { code: 'UNAUTHENTICATED' },
    });
    await result;
    expect(auth.unauthenticated).not.toHaveBeenCalled();
  });
  it('authentication loss removes private Match state', async () => {
    const result = match.command('JoinMatch', id);
    socket.accept();
    await result;
    socket.receive('LobbySnapshot', lobby());
    state.set({ status: 'anonymous' });
    TestBed.tick();
    expect(match.snapshot()).toBeUndefined();
    expect(match.matchId()).toBeUndefined();
  });
  it('maps rejected joins to safe feedback', async () => {
    const result = match.command('JoinMatch', id);
    socket.emitted[0].ack({
      commandId: socket.emitted[0].request.commandId,
      status: 'rejected',
      matchId: id,
      error: { code: 'MATCH_FULL' },
    });
    await result;
    expect(match.feedback()).toContain('ten players');
    expect(match.uncertain()).toBe(false);
  });
  it('internal command failure is uncertain rather than claiming rollback', async () => {
    const result = match.command('CreateMatch');
    socket.emitted[0].ack({
      commandId: socket.emitted[0].request.commandId,
      status: 'error',
      error: { code: 'LOBBY_UNAVAILABLE' },
    });
    await result;
    expect(match.uncertain()).toBe(true);
  });
  it('a historical ACK cannot overwrite a newer command intent', async () => {
    const first = match.command('JoinMatch', id);
    socket.accept();
    await first;
    const second = match.command('JoinMatch', other);
    socket.accept(0);
    expect(match.matchId()).toBe(other);
    expect(match.busy()).toBe(true);
    const request = socket.emitted[1];
    request.ack({
      commandId: request.request.commandId,
      status: 'accepted',
      matchId: other,
      version: 1,
    });
    await second;
    expect(match.matchId()).toBe(other);
  });
  it('a disconnect settles the pending caller with an uncertain outcome', async () => {
    const result = match.command('CreateMatch');
    socket.receive('disconnect', 'transport close');
    expect(await result).toBeUndefined();
    expect(match.uncertain()).toBe(true);
  });
  it('current UNAUTHENTICATED ACK delegates invalidation to the sole Session owner', async () => {
    const result = match.command('CreateMatch');
    const request = socket.emitted[0];
    request.ack({
      commandId: request.request.commandId,
      status: 'error',
      error: { code: 'UNAUTHENTICATED' },
    });
    await result;
    expect(auth.unauthenticated).toHaveBeenCalledWith(1);
  });
  it('keeps the healthy lobby and blocks commands while verification is pending or inconclusive', async () => {
    const join = match.command('JoinMatch', id);
    socket.accept();
    await join;
    socket.receive('LobbySnapshot', lobby(4));
    const view = match.snapshot();
    auth.verification.set('pending');
    expect(match.live()).toBe(true);
    await match.command('StartMatch', id);
    auth.verification.set('unavailable');
    expect(match.canStart()).toBe(false);
    expect(socket.emitted).toHaveLength(1);
    expect(match.snapshot()).toBe(view);
    auth.verification.set(undefined);
    expect(match.canStart()).toBe(true);
  });

  it('reconciles a visible generic handshake failure without treating it as a 401', () => {
    const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    try {
      socket.receive('connect_error', new Error('xhr poll error'));
      expect(auth.revalidate).toHaveBeenCalledOnce();
      expect(auth.unauthenticated).not.toHaveBeenCalled();
      expect(match.statusMessage()).toContain('opening a new connection');
    } finally {
      visibility.mockRestore();
    }
  });

  it('replaces a lost transport only after verification and preserves an unresolved command ID', async () => {
    const command = match.command('CreateMatch');
    socket.receive('disconnect');
    await command;
    const owner = { destroyed: false, onDestroy: vi.fn() };
    auth.revalidate.mockResolvedValue({ status: 'authenticated', player: player() });
    await Promise.all([match.reconnect(owner), match.reconnect(owner)]);
    expect(match.live()).toBe(true);
    expect(socket.emitted).toHaveLength(1);
    const retry = match.retry();
    expect(socket.emitted[1].request).toEqual(socket.emitted[0].request);
    socket.accept(1);
    await retry;
  });

  it.each(['navigation', 'logout', 'unavailable'])(
    'does not reopen a socket after %s supersedes recovery',
    async (reason) => {
      socket.receive('disconnect');
      const owner = { destroyed: false, onDestroy: vi.fn() };
      let resolve!: (state: { status: 'authenticated' }) => void;
      auth.revalidate.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const retry = match.reconnect(owner);
      if (reason === 'navigation') owner.destroyed = true;
      else if (reason === 'logout') auth.generation++;
      else auth.verification.set('unavailable');
      resolve({ status: 'authenticated' });
      await retry;
      expect(match.connection()).toBe('lost');
    },
  );
});
