import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { Session } from '../auth/session.js';
import { MatchLobby, leaveLobby } from './match-lobby.js';
import { MATCH_SOCKET, MatchSession } from './match-session.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const rules = {
  questionCount: 10,
  answerWindowMs: 10000,
  revealDurationMs: 5000,
  allowAnswerChanges: true,
  maxAttempts: 3,
  earlyClose: false,
};
describe('Lobby route and presentation', () => {
  const player = signal({ id: 'a', displayName: 'Alice' });
  const factory = vi.fn();
  const params = new BehaviorSubject(convertToParamMap({ matchId: id }));
  beforeEach(() => {
    params.next(convertToParamMap({ matchId: id }));
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
            verification: signal(undefined),
            watchForeground: vi.fn(),
            logout: vi.fn(),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ matchId: id }) },
            paramMap: params,
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
      state: {
        hostPlayerId: 'a',
        rules,
        participants: [
          { playerId: 'a', displayName: 'Alice' },
          { playerId: 'b', displayName: 'Bob' },
        ],
      },
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
  it('renders stable native answer controls, keeps focus inert and clamps the timer without advancing', async () => {
    const match = TestBed.inject(MatchSession);
    match.matchId.set(id);
    match.connection.set('connected');
    match.snapshot.set({
      matchId: id,
      version: 3,
      phase: 'QUESTION_OPEN',
      state: {
        questionNumber: 1,
        questionCount: 10,
        deadlineAt: new Date(0).toISOString(),
        question: {
          questionId: 'q',
          text: 'Pick one',
          choices: [
            { choiceId: 'a', text: 'Alpha' },
            { choiceId: 'b', text: 'Beta' },
          ],
        },
        participants: [
          {
            playerId: 'a',
            displayName: 'Alice',
            score: { scoreUnits: '9007199254740993' },
            rank: 1,
          },
        ],
        ownSubmission: { choiceId: 'a', attemptCount: 1, finalAnsweredMs: 10 },
      },
    });
    const interval = vi.spyOn(window, 'setInterval');
    const clear = vi.spyOn(window, 'clearInterval');
    const answer = vi.spyOn(match, 'answer').mockResolvedValue(undefined);
    const fixture = TestBed.createComponent(MatchLobby);
    await fixture.whenStable();
    const html: HTMLElement = fixture.nativeElement;
    expect(html.textContent).toContain('Time left: 0s');
    expect(html.textContent).toContain('9007199254740993');
    expect(html.querySelector('.primary')).toBeNull();
    const choices = html.querySelectorAll<HTMLButtonElement>('.choices button');
    expect(choices[0].getAttribute('aria-pressed')).toBe('true');
    choices[1].focus();
    expect(answer).not.toHaveBeenCalled();
    choices[1].click();
    expect(answer).toHaveBeenCalledWith(id, 'q', 'b');
    match.intent.set({
      event: 'SubmitAnswer',
      commandId: 'answer',
      payload: { matchId: id, questionId: 'q', choiceId: 'b' },
      status: 'pending',
    });
    await fixture.whenStable();
    expect(choices[1].textContent).toContain('Submitting');
    expect(choices[0].getAttribute('aria-pressed')).toBe('true');
    expect(match.snapshot()?.phase).toBe('QUESTION_OPEN');
    const timerIndex = interval.mock.calls.findIndex(([, delay]) => delay === 250);
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    const timer = interval.mock.results[timerIndex].value;
    match.connection.set('lost');
    await fixture.whenStable();
    expect(html.textContent).toContain('Time left: Unavailable');
    expect(clear).toHaveBeenCalledWith(timer);
    vi.restoreAllMocks();
  });
  it('hides retry after a same-component Match ID change', async () => {
    const match = TestBed.inject(MatchSession);
    match.matchId.set(id);
    match.connection.set('connected');
    match.snapshot.set({
      matchId: id,
      version: 2,
      phase: 'WAITING',
      state: { hostPlayerId: 'a', rules, participants: [{ playerId: 'a', displayName: 'Alice' }] },
    });
    match.intent.set({
      event: 'StartMatch',
      commandId: 'start',
      payload: { matchId: id },
      status: 'uncertain',
    });
    const fixture = TestBed.createComponent(MatchLobby);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Retry original command');
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    params.next(convertToParamMap({ matchId: other }));
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).not.toContain('Retry original command');
    expect(fixture.nativeElement.textContent).toContain('No live subscription');
    expect(await match.retry(other)).toBeUndefined();
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
