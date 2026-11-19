import { DatePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HistoryApi } from './history-api.js';
import { historyError, historyRead } from './history-read.js';

@Component({
  selector: 'app-history-list',
  imports: [DatePipe, RouterLink],
  templateUrl: './history-list.html',
  styleUrl: './history.scss',
})
export class HistoryList {
  private readonly api = inject(HistoryApi);
  protected readonly history = historyRead(
    () => '',
    () => this.api.list(),
  );
  protected readonly errorMessage = historyError;

  protected loadMore(): void {
    const { data, error } = this.history.state();
    if (data?.nextCursor == null || error === 400) return;
    const cursor = data.nextCursor;
    this.history.append(
      () => this.api.list(cursor),
      (page, previous) => ({
        items: [...(previous?.items ?? []), ...page.items],
        nextCursor: page.nextCursor,
      }),
    );
  }
}
