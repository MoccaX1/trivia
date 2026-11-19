import { DatePipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Session } from '../auth/session.js';
import { HistoryApi } from './history-api.js';
import { historyError, historyRead } from './history-read.js';

@Component({
  selector: 'app-history-detail',
  imports: [DatePipe, RouterLink],
  templateUrl: './history-detail.html',
  styleUrl: './history.scss',
})
export class HistoryDetail {
  private readonly api = inject(HistoryApi);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.paramMap, {
    initialValue: this.route.snapshot.paramMap,
  });
  protected readonly viewer = inject(Session).player;
  protected readonly history = historyRead(
    () => this.params().get('matchId') ?? '',
    (id) => this.api.detail(id),
  );
  protected readonly ownStanding = computed(() =>
    this.history.state().data?.participants.find((player) => player.playerId === this.viewer()?.id),
  );
  protected readonly errorMessage = historyError;
}
