import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
  protected readonly id = signal(this.route.snapshot.paramMap.get('matchId') ?? '');
  protected readonly current = computed(() =>
    this.match.matchId() === this.id() ? this.match.snapshot() : undefined,
  );
  protected readonly copied = signal('');
  constructor() {
    this.session.watchForeground(this.destroy);
    this.route.paramMap
      .pipe(takeUntilDestroyed())
      .subscribe((params) => this.id.set(params.get('matchId') ?? ''));
    effect(() => {
      if (!this.session.player() && this.session.state().status !== 'checking')
        void this.router.navigateByUrl('/login', { replaceUrl: true });
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
