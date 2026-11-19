import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';

interface Score {
  scoreUnits: string;
}

export interface HistoryPage {
  items: {
    matchId: string;
    finishedAt: string;
    ownResult: { score: Score; rank: number };
    participantCount: number;
  }[];
  nextCursor: string | null;
}

export interface HistoryResult {
  match: { matchId: string; startedAt: string; finishedAt: string; hostPlayerId: string };
  participants: { playerId: string; displayName: string; score: Score; rank: number }[];
  questions: {
    questionNumber: number;
    text: string;
    choices: { choiceId: string; text: string }[];
    correctChoiceId: string;
    ownResult: {
      selectedChoiceId: string | null;
      attemptCount: number;
      finalAnsweredMs: number | null;
      score: Score;
    };
  }[];
}

@Injectable({ providedIn: 'root' })
export class HistoryApi {
  private readonly http = inject(HttpClient);

  list(cursor?: string) {
    return this.http.get<HistoryPage>('/history', {
      withCredentials: true,
      timeout: 10_000,
      params: cursor === undefined ? {} : { cursor },
    });
  }

  detail(matchId: string) {
    return this.http.get<HistoryResult>(`/history/${encodeURIComponent(matchId)}`, {
      withCredentials: true,
      timeout: 10_000,
    });
  }
}
