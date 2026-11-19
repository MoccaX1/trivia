import { DOCUMENT } from '@angular/common';
import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  InjectionToken,
  signal,
} from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Session } from '../auth/session.js';
import { isMatchSnapshot, type MatchSnapshot } from './match-snapshot.js';

export const MATCH_SOCKET = new InjectionToken<() => Socket>('Match socket', {
  providedIn: 'root',
  factory: () => () =>
    io({ path: '/socket.io', withCredentials: true, autoConnect: false, reconnection: false }),
});
export const matchIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type MatchCommand = 'CreateMatch' | 'JoinMatch' | 'StartMatch';
interface Intent {
  event: MatchCommand | 'SubmitAnswer';
  readonly commandId: string;
  readonly payload: Readonly<Record<string, string>>;
  status: 'pending' | 'uncertain' | 'accepted' | 'rejected';
  receiptVersion?: number;
}
interface Ack {
  commandId: string;
  status: 'accepted' | 'rejected' | 'error';
  matchId?: string;
  version?: number;
  error?: { code: string };
}
const messages: Record<string, string> = {
  MATCH_NOT_FOUND: 'That Match was not found. Check the ID with the Host.',
  ALREADY_MATCH_PARTICIPANT:
    'You are already a member. This connection cannot restore the previous subscription.',
  MATCH_FULL: 'This Match already has ten players.',
  NOT_MATCH_PARTICIPANT: 'This account is not a participant in the Match.',
  NOT_HOST: 'Only the Host can start this Match.',
  INSUFFICIENT_PARTICIPANTS: 'At least two players are needed to start.',
  INVALID_MATCH_PHASE: 'This action is no longer available in the current Match phase.',
  MATCH_FINISHED: 'This Match has finished.',
  INVALID_REQUEST: 'The request was not valid. Check the Match ID.',
  QUESTION_NOT_CURRENT: 'That question is no longer current.',
  INVALID_CHOICE: 'That answer is unavailable for this question.',
  ANSWER_WINDOW_CLOSED: 'The server closed the answer window.',
  MAX_ATTEMPTS_EXCEEDED: 'The server has recorded all three attempts.',
  INVALID_TIMING: 'The server could not validate the answer timing.',
};
const unknownOutcome =
  'The outcome is unknown. Do not assume the action failed. An explicit retry uses the same command; a receipt cannot restore a lost subscription.';

@Injectable({ providedIn: 'root' })
export class MatchSession {
  private readonly auth = inject(Session);
  private readonly document = inject(DOCUMENT);
  private readonly createSocket = inject(MATCH_SOCKET);
  private socket?: Socket;
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private buffered?: unknown;
  private finish?: () => void;
  readonly connection = signal<'idle' | 'connecting' | 'connected' | 'lost'>('idle');
  readonly matchId = signal<string | undefined>(undefined);
  readonly snapshot = signal<MatchSnapshot | undefined>(undefined);
  readonly intent = signal<Intent | undefined>(undefined);
  readonly feedback = signal('');
  readonly live = computed(() => this.connection() === 'connected');
  readonly canSend = computed(
    () => this.live() && !!this.auth.player() && !this.auth.verification(),
  );
  readonly statusMessage = computed(() => {
    switch (this.auth.verification()) {
      case 'pending':
        return 'Checking your session…';
      case 'unavailable':
        return 'We couldn’t verify your session. Check your connection and try again.';
      default:
        return this.feedback();
    }
  });
  readonly busy = computed(() => this.intent()?.status === 'pending');
  readonly uncertain = computed(() => this.intent()?.status === 'uncertain');
  private readonly lobby = computed(() => {
    const snapshot = this.snapshot();
    return snapshot?.phase === 'WAITING' ? snapshot.state : undefined;
  });
  readonly isHost = computed(
    () => !!this.lobby() && this.lobby()?.hostPlayerId === this.auth.player()?.id,
  );
  readonly canStart = computed(
    () =>
      this.canSend() &&
      !(this.intent()?.event === 'StartMatch' && this.intent()?.status === 'accepted') &&
      this.isHost() &&
      !this.busy() &&
      !this.uncertain() &&
      (this.lobby()?.participants.length ?? 0) >= 2,
  );
  readonly awaitingAnswerView = computed(() => {
    const intent = this.intent();
    return (
      intent?.event === 'SubmitAnswer' &&
      intent.status === 'accepted' &&
      (intent.receiptVersion ?? 0) > (this.snapshot()?.version ?? 0)
    );
  });

  canAnswer(matchId: string, choiceId: string): boolean {
    const snapshot = this.snapshot();
    if (
      !this.canSend() ||
      this.busy() ||
      this.uncertain() ||
      snapshot?.matchId !== matchId ||
      snapshot.phase !== 'QUESTION_OPEN'
    )
      return false;
    const { question, ownSubmission } = snapshot.state;
    return (
      choiceId !== ownSubmission?.choiceId &&
      (ownSubmission?.attemptCount ?? 0) < 3 &&
      !(this.awaitingAnswerView() && this.intent()?.payload['choiceId'] === choiceId) &&
      question.choices.some((choice) => choice.choiceId === choiceId)
    );
  }

  async answer(matchId: string, questionId: string, choiceId: string): Promise<void> {
    const snapshot = this.snapshot();
    if (
      snapshot?.phase !== 'QUESTION_OPEN' ||
      snapshot.state.question.questionId !== questionId ||
      !this.canAnswer(matchId, choiceId)
    )
      return;
    await this.send({
      event: 'SubmitAnswer',
      commandId: crypto.randomUUID(),
      payload: Object.freeze({ matchId, questionId, choiceId }),
      status: 'pending',
    });
  }

  constructor() {
    effect(() => {
      if (this.auth.state().status !== 'authenticated') this.clear();
    });
    const warn = (event: BeforeUnloadEvent) => {
      if (this.matchId()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    inject(DestroyRef).onDestroy(() => {
      this.clear();
      window.removeEventListener('beforeunload', warn);
    });
  }
  connect(): void {
    if (!this.auth.player() || this.socket) return;
    const epoch = ++this.epoch;
    const generation = this.auth.generation;
    const socket = this.createSocket();
    this.socket = socket;
    this.connection.set('connecting');
    const current = () => epoch === this.epoch && generation === this.auth.generation;
    socket.on('connect', () => {
      if (current()) {
        this.connection.set('connected');
        this.feedback.set('Connected. Create a Match or enter an ID to join.');
      }
    });
    socket.on('connect_error', (error: Error) => {
      if (!current()) return;
      this.connection.set('lost');
      this.feedback.set('Connection unavailable. Try opening a new connection.');
      if (error.message === 'UNAUTHENTICATED') this.auth.unauthenticated(generation);
      else this.verifyVisible();
    });
    socket.on('disconnect', () => {
      if (!current()) return;
      this.connection.set('lost');
      this.finish?.();
      this.finish = undefined;
      clearTimeout(this.timer);
      if (this.busy()) this.intent.update((value) => value && { ...value, status: 'uncertain' });
      this.feedback.set(
        'Connection lost. The view is stale; disconnect does not remove membership. Match subscriptions cannot be restored automatically.',
      );
      this.verifyVisible();
    });
    for (const event of ['LobbySnapshot', 'MatchSnapshot'])
      socket.on(event, (value: unknown) => {
        if (!current()) return;
        const phase = (value as { phase?: unknown } | null)?.phase;
        if ((event === 'LobbySnapshot') !== (phase === 'WAITING')) return;
        if (!this.matchId() && this.intent()?.event === 'CreateMatch') this.buffered = value;
        else this.apply(value);
      });
    socket.connect();
  }
  private verifyVisible(): void {
    if (!this.document.hidden) void this.auth.revalidate();
  }

  async reconnect(owner: DestroyRef): Promise<void> {
    if (this.connection() !== 'lost' || !this.auth.player()) return;
    const epoch = this.epoch;
    const generation = this.auth.generation;
    const state = await this.auth.revalidate();
    if (
      owner.destroyed ||
      epoch !== this.epoch ||
      generation !== this.auth.generation ||
      this.connection() !== 'lost' ||
      state.status !== 'authenticated' ||
      this.auth.verification()
    )
      return;
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = undefined;
    this.buffered = undefined;
    this.snapshot.set(undefined);
    this.matchId.set(undefined);
    this.connect();
  }

  clear(): void {
    this.finish?.();
    this.finish = undefined;
    ++this.epoch;
    clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.removeAllListeners();
    socket?.disconnect();
    this.connection.set('idle');
    this.matchId.set(undefined);
    this.snapshot.set(undefined);
    this.intent.set(undefined);
    this.feedback.set('');
    this.buffered = undefined;
  }
  async command(event: MatchCommand, matchId?: string): Promise<string | undefined> {
    if (!this.canSend() || this.busy() || this.uncertain()) return;
    if (event !== 'CreateMatch' && (!matchId || !matchIdPattern.test(matchId))) {
      this.feedback.set('Enter the complete Match UUID exactly as shared by the Host.');
      return;
    }
    if (event === 'StartMatch' && (!this.canStart() || matchId !== this.matchId())) return;
    if (event !== 'StartMatch') {
      this.snapshot.set(undefined);
      this.matchId.set(matchId);
    }
    return this.send({
      event,
      commandId: crypto.randomUUID(),
      payload: matchId ? Object.freeze({ matchId }) : Object.freeze({}),
      status: 'pending',
    });
  }
  canRetry(routeMatchId?: string): boolean {
    const intent = this.intent();
    if (intent?.status !== 'uncertain' || !this.canSend()) return false;
    if (routeMatchId === undefined)
      return intent.event === 'CreateMatch' || intent.event === 'JoinMatch';
    if (routeMatchId !== this.matchId() || routeMatchId !== intent.payload['matchId']) return false;
    const snapshot = this.snapshot();
    if (intent.event === 'StartMatch') return snapshot?.phase === 'WAITING' && this.isHost();
    return (
      intent.event === 'SubmitAnswer' &&
      snapshot?.phase === 'QUESTION_OPEN' &&
      snapshot.state.question.questionId === intent.payload['questionId']
    );
  }

  retry(routeMatchId?: string): Promise<string | undefined> {
    const intent = this.intent();
    return intent && this.canRetry(routeMatchId) ? this.send(intent) : Promise.resolve(undefined);
  }
  private send(intent: Intent): Promise<string | undefined> {
    const epoch = this.epoch;
    const generation = this.auth.generation;
    this.intent.set({ ...intent, status: 'pending' });
    this.feedback.set('Waiting for server confirmation…');
    return new Promise((resolve) => {
      const finish = () => resolve(undefined);
      this.finish = finish;
      this.timer = setTimeout(() => {
        if (epoch !== this.epoch || generation !== this.auth.generation || this.finish !== finish) {
          resolve(undefined);
          return;
        }
        this.intent.set({ ...intent, status: 'uncertain' });
        this.feedback.set(unknownOutcome);
        resolve(undefined);
      }, 5000);
      this.socket?.emit(
        intent.event,
        Object.freeze({ commandId: intent.commandId, payload: intent.payload }),
        (ack: Ack) => {
          if (
            epoch !== this.epoch ||
            generation !== this.auth.generation ||
            ack?.commandId !== intent.commandId
          ) {
            resolve(undefined);
            return;
          }
          if (ack.status === 'error' && ack.error?.code === 'UNAUTHENTICATED')
            this.auth.unauthenticated(generation);
          if (generation !== this.auth.generation || this.finish !== finish) {
            resolve(undefined);
            return;
          }
          clearTimeout(this.timer);
          this.finish = undefined;
          if (
            ack.status === 'accepted' &&
            Number.isSafeInteger(ack.version) &&
            (ack.version ?? 0) > 0 &&
            typeof ack.matchId === 'string' &&
            matchIdPattern.test(ack.matchId) &&
            (intent.event === 'CreateMatch' || ack.matchId === intent.payload['matchId'])
          ) {
            this.matchId.set(ack.matchId);
            this.intent.set({ ...intent, status: 'accepted', receiptVersion: ack.version });
            if (intent.event === 'SubmitAnswer') {
              this.feedback.set(
                this.awaitingAnswerView()
                  ? 'Answer receipt accepted. Waiting for the server view.'
                  : 'Answer receipt accepted. The selection shown is the current server view.',
              );
              resolve(ack.matchId);
              return;
            }
            this.apply(this.buffered);
            this.buffered = undefined;
            this.feedback.set(
              this.snapshot()
                ? 'Lobby view received from the server.'
                : 'Request confirmed. Waiting for the current lobby view.',
            );
            resolve(ack.matchId);
          } else {
            const code = ack.error?.code;
            const uncertain =
              code === 'LOBBY_UNAVAILABLE' || !['error', 'rejected'].includes(ack.status);
            this.intent.set({ ...intent, status: uncertain ? 'uncertain' : 'rejected' });
            this.feedback.set(
              uncertain
                ? unknownOutcome
                : (messages[code ?? ''] ??
                    'The server rejected this action. No new state is implied.'),
            );
            resolve(undefined);
          }
        },
      );
    });
  }
  private apply(value: unknown): void {
    const viewer = this.auth.player();
    if (
      !viewer ||
      !isMatchSnapshot(value, viewer.id) ||
      value.matchId !== this.matchId() ||
      value.version <= (this.snapshot()?.version ?? 0)
    )
      return;
    this.snapshot.set(value);
    const intent = this.intent();
    if (
      (intent?.event === 'SubmitAnswer' &&
        (value.phase !== 'QUESTION_OPEN' ||
          value.state.question.questionId !== intent.payload['questionId'])) ||
      (intent?.event === 'StartMatch' && value.phase !== 'WAITING')
    ) {
      clearTimeout(this.timer);
      this.finish?.();
      this.finish = undefined;
      this.intent.set(undefined);
      this.feedback.set('');
    } else if (
      intent?.event === 'SubmitAnswer' &&
      intent.status === 'accepted' &&
      !this.awaitingAnswerView()
    ) {
      this.feedback.set('Answer receipt accepted. The selection shown is the current server view.');
    } else if (intent?.event !== 'SubmitAnswer' && intent?.status === 'accepted') {
      this.feedback.set(
        value.phase === 'WAITING'
          ? 'Lobby view is up to date.'
          : 'The server has moved this Match beyond the lobby.',
      );
    }
  }
}
