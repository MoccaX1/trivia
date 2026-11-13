import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { Session } from '../auth/session.js';
import { MatchLobby, leaveLobby } from './match-lobby.js';
import { MATCH_SOCKET, MatchSession } from './match-session.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('Lobby route and presentation', () => {
  const player = signal({ id: 'a', displayName: 'Alice' });
  const factory = vi.fn();
  beforeEach(() => {
    player.set({ id: 'a', displayName: 'Alice' });
    factory.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: MATCH_SOCKET, useValue: factory },
        {
          provide: Session,
          useValue: {
            player,
            state: signal({ status: 'authenticated' }),
            pending: signal(undefined),
            logout: vi.fn(),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ matchId: id }) },
            paramMap: of(convertToParamMap({ matchId: id })),
          },
        },
      ],
    });
  });
  it('a refreshed or directly linked route never silently connects or joins', async () => {
    const fixture = TestBed.createComponent(MatchLobby);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('No live subscription');
    expect(factory).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('input')).toBeNull();
  });
  it('renders trusted participants and only the Host Start control', async () => {
    const match = TestBed.inject(MatchSession);
    match.matchId.set(id);
    match.connection.set('connected');
    match.snapshot.set({
      matchId: id,
      version: 1,
      phase: 'WAITING',
      hostPlayerId: 'a',
      participants: [
        { playerId: 'a', displayName: 'Alice' },
        { playerId: 'b', displayName: 'Bob' },
      ],
    });
    const fixture = TestBed.createComponent(MatchLobby);
    await fixture.whenStable();
    const html: HTMLElement = fixture.nativeElement;
    expect(html.querySelectorAll('li')).toHaveLength(2);
    expect(html.textContent).toContain('Host · You');
    expect(html.querySelector<HTMLButtonElement>('.primary')?.disabled).toBe(false);
    player.set({ id: 'b', displayName: 'Bob' });
    await fixture.whenStable();
    expect(html.querySelector('.primary')).toBeNull();
    expect(html.textContent).toContain('The Host starts');
  });
  it('hides Start after the authoritative handoff and never creates answer controls', async () => {
    const match = TestBed.inject(MatchSession);
    match.matchId.set(id);
    match.connection.set('connected');
    match.snapshot.set({
      matchId: id,
      version: 3,
      phase: 'QUESTION_OPEN',
      participants: [{ playerId: 'a', displayName: 'Alice' }],
    });
    const fixture = TestBed.createComponent(MatchLobby);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Gameplay UI arrives in Stage 4');
    expect(fixture.nativeElement.querySelector('.primary')).toBeNull();
    expect(fixture.nativeElement.querySelector('input')).toBeNull();
  });
  it('route destruction clears the local socket state without dispatching Leave', async () => {
    const match = TestBed.inject(MatchSession);
    match.matchId.set(id);
    const fixture = TestBed.createComponent(MatchLobby);
    await fixture.whenStable();
    fixture.destroy();
    expect(match.matchId()).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });
  it('navigation warning can cancel leaving; it is not a Leave command', () => {
    const match = TestBed.inject(MatchSession);
    match.matchId.set(id);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const result = TestBed.runInInjectionContext(() =>
      (leaveLobby as unknown as (...args: unknown[]) => unknown)(null, null, null, {
        url: '/play',
      }),
    );
    expect(result).toBe(false);
    expect(match.matchId()).toBe(id);
    confirm.mockRestore();
  });
});
