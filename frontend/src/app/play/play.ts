import { Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { form, FormField, required, submit, validate } from '@angular/forms/signals';
import { MatchSession, matchIdPattern } from '../match/match-session.js';
import { Session } from '../auth/session.js';

@Component({
  selector: 'app-play',
  imports: [FormField, RouterLink],
  templateUrl: './play.html',
  styleUrl: './play.scss',
})
export class Play {
  protected readonly session = inject(Session);
  private readonly router = inject(Router);
  protected readonly match = inject(MatchSession);
  private readonly destroy = inject(DestroyRef);
  private readonly model = signal({ matchId: '' });
  protected readonly fields = form(this.model, (path) => {
    required(path.matchId, { message: 'Enter a Match ID.' });
    validate(path.matchId, ({ value }) =>
      matchIdPattern.test(value())
        ? undefined
        : { kind: 'format', message: 'Enter the complete Match UUID exactly as shared.' },
    );
  });
  protected async create(): Promise<void> {
    await this.enter('CreateMatch');
  }
  protected join(event: Event): void {
    event.preventDefault();
    if (this.match.busy() || this.match.uncertain()) return;
    void submit(this.fields, async () => {
      await this.enter('JoinMatch');
    });
  }
  private async enter(event: 'CreateMatch' | 'JoinMatch'): Promise<void> {
    const id = await this.match.command(
      event,
      event === 'JoinMatch' ? this.model().matchId : undefined,
    );
    if (!this.destroy.destroyed && id) await this.router.navigate(['/play/match', id]);
  }
  protected async retry(): Promise<void> {
    const id = await this.match.retry();
    if (!this.destroy.destroyed && id) await this.router.navigate(['/play/match', id]);
  }
  protected reconnect(): void {
    void this.match.reconnect(this.destroy);
  }
  constructor() {
    this.session.watchForeground(this.destroy);
    this.match.connect();
    this.destroy.onDestroy(() => {
      const destination = this.router.currentNavigation()?.finalUrl?.toString();
      if (destination !== `/play/match/${this.match.matchId()}`) this.match.clear();
    });

    effect(() => {
      const state = this.session.state();
      if (state.status === 'anonymous' || state.status === 'unavailable') {
        void this.router.navigateByUrl('/login', { replaceUrl: true });
      }
    });
  }
}
