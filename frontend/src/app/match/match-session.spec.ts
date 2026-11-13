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
  accept(index = 0) {
    const command = this.emitted[index];
    command.ack({
      commandId: command.request.commandId,
      status: 'accepted',
      matchId: id,
      version: 1,
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
      participants: [
        { playerId: 'a', displayName: 'Alice' },
        { playerId: 'b', displayName: 'Bob' },
      ],
    },
  };
}
describe('Match Session authoritative lifecycle', () => {
  let socket: FakeSocket;
  let match: MatchSession;
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
    check: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    socket = new FakeSocket();
    player.set({ id: 'a', displayName: 'Alice' });
    state.set({ status: 'authenticated' });
    auth = { state, player, generation: 1, unauthenticated: vi.fn(), check: vi.fn() };
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
    expect(match.snapshot()?.participants).toHaveLength(2);
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
  it('uses one version tracker across handoff without exposing questions', async () => {
    const result = match.command('JoinMatch', id);
    socket.accept();
    await result;
    socket.receive('LobbySnapshot', lobby(2));
    socket.receive('MatchSnapshot', { ...lobby(3), phase: 'QUESTION_OPEN' });
    socket.receive('LobbySnapshot', lobby(2));
    expect(match.snapshot()?.phase).toBe('QUESTION_OPEN');
    expect(match.canStart()).toBe(false);
    expect(match.snapshot()).not.toHaveProperty('question');
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
    expect(match.snapshot()?.participants).toHaveLength(2);
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
});
