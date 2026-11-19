import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DOCUMENT } from '@angular/common';
import { Component, computed, DestroyRef, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, CanDeactivateFn, Router, RouterLink } from '@angular/router';
import { Session } from '../auth/session.js';
import { MatchSession } from './match-session.js';

@Component({
  selector: 'app-match-lobby',
  imports: [RouterLink],
  templateUrl: './match-lobby.html',
  styleUrl: './match-lobby.scss',
})
export class MatchLobby {
  protected readonly match = inject(MatchSession);
  protected readonly session = inject(Session);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  protected readonly id = signal(this.route.snapshot.paramMap.get('matchId') ?? '');
  protected readonly current = computed(() =>
    this.match.matchId() === this.id() ? this.match.snapshot() : undefined,
  );
  protected readonly standings = computed(() => {
    const snapshot = this.current();
    return snapshot?.phase === 'REVEAL' || snapshot?.phase === 'FINISHED'
      ? [...snapshot.state.participants].sort((first, second) => first.rank - second.rank)
      : [];
  });
  protected readonly viewerStanding = computed(() =>
    this.standings().find((player) => player.playerId === this.session.player()?.id),
  );
  protected readonly copied = signal('');
  private readonly now = signal(Date.now());
  private readonly deadline = computed(() => {
    const snapshot = this.current();
    return this.match.live() && snapshot?.phase === 'QUESTION_OPEN'
      ? Date.parse(snapshot.state.deadlineAt)
      : undefined;
  });
  protected readonly seconds = computed(() => {
    const deadline = this.deadline();
    return deadline === undefined
      ? undefined
      : Math.max(0, Math.ceil((deadline - this.now()) / 1000));
  });
  protected readonly requestedChoice = computed(() => {
    const intent = this.match.intent();
    return intent?.event === 'SubmitAnswer' &&
      intent.payload['matchId'] === this.id() &&
      (intent.status === 'pending' ||
        intent.status === 'uncertain' ||
        this.match.awaitingAnswerView())
      ? intent.payload['choiceId']
      : undefined;
  });
  constructor() {
    this.session.watchForeground(this.destroy);
    this.route.paramMap
      .pipe(takeUntilDestroyed())
      .subscribe((params) => this.id.set(params.get('matchId') ?? ''));
    effect(() => {
      if (!this.session.player() && this.session.state().status !== 'checking')
        void this.router.navigateByUrl('/login', { replaceUrl: true });
    });
    effect((cleanup) => {
      if (this.deadline() === undefined) return;
      const tick = () => this.now.set(Date.now());
      tick();
      const timer = setInterval(tick, 250);
      this.document.addEventListener('visibilitychange', tick);
      cleanup(() => {
        clearInterval(timer);
        this.document.removeEventListener('visibilitychange', tick);
      });
    });
    this.destroy.onDestroy(() => this.match.clear());
  }
  protected async start(): Promise<void> {
    await this.match.command('StartMatch', this.id());
  }
  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.id());
      this.copied.set('Match ID copied. Share it with players so they can explicitly join.');
    } catch {
      this.copied.set('Copy is unavailable. Select and copy the Match ID above.');
    }
  }
}
export const leaveLobby: CanDeactivateFn<MatchLobby> = (_component, _route, _state, next) => {
  const match = inject(MatchSession);
  if (next.url.startsWith('/login') || !match.matchId()) return true;
  return window.confirm(
    'Leave this Match view? Participation may not be recoverable in M1. Navigation does not send LeaveMatch or cancel the Match.',
  );
};
