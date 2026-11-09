import type { MatchResult } from '../domain/match-engine.js';
import { correctAnswerScore } from '../domain/match-engine.js';

export class CompletionError extends Error {
  constructor(
    readonly code:
      | 'INVALID_COMPLETION'
      | 'COMPLETION_CONFLICT'
      | 'COMPLETION_STORAGE_FAILURE'
      | 'COMPLETION_UNCONFIRMED',
  ) {
    super(code);
  }
}
export interface CompletedMatchWriter {
  save(result: MatchResult): Promise<void>;
}

/** Exactly the approved durable facts; no source lineage or Engine-only clocks/IDs. */
export interface DurableMatch {
  match: { id: string; host: string; started: string; finished: string };
  participants: { player: string; finished: string; score: string; rank: number }[];
  questions: { position: number; text: string; correct: string }[];
  choices: { position: number; key: string; order: number; text: string }[];
  answers: {
    position: number;
    player: string;
    selected: string | null;
    attempts: number;
    elapsed: number | null;
    score: string;
  }[];
}
function requireFact(valid: boolean): asserts valid {
  if (!valid) throw new CompletionError('INVALID_COMPLETION');
}
function uuid(id: string): string {
  requireFact(
    typeof id === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id),
  );
  return id.toLowerCase();
}
function time(value: number): string {
  requireFact(Number.isSafeInteger(value) && !Number.isNaN(new Date(value).getTime()));
  return new Date(value).toISOString();
}
function text(value: string): void {
  requireFact(typeof value === 'string' && value.trim().length > 0);
}
function score(value: bigint): string {
  requireFact(typeof value === 'bigint' && value >= 0n && value <= 9_223_372_036_854_775_807n);
  return value.toString();
}

export function durableMatch(result: MatchResult): DurableMatch {
  try {
    const id = uuid(result.matchId),
      host = uuid(result.hostPlayerId);
    const started = time(result.startedAt),
      finished = time(result.finishedAt);
    requireFact(result.startedAt < result.finishedAt);
    requireFact(
      result.participants.length >= 2 &&
        result.participants.length <= 10 &&
        result.resolvedQuestions.length === 10,
    );
    const participants = result.participants
      .map((p) => ({
        player: uuid(p.playerId),
        finished,
        score: score(p.finalScoreUnits),
        rank: p.finalRank,
      }))
      .sort((a, b) => (a.player < b.player ? -1 : a.player > b.player ? 1 : 0));
    const ids = new Set(participants.map((p) => p.player));
    requireFact(ids.size === participants.length && ids.has(host));
    const totals = new Map(participants.map((p) => [p.player, 0n]));
    const graph: DurableMatch = {
      match: { id, host, started, finished },
      participants,
      questions: [],
      choices: [],
      answers: [],
    };
    result.resolvedQuestions.forEach((resolved, index) => {
      requireFact(
        resolved.questionIndex === index && resolved.results.length === participants.length,
      );
      const q = resolved.question,
        position = index + 1;
      text(q.text);
      text(q.correctChoiceId);
      const keys = new Set(q.choices.map((c) => c.id));
      requireFact(
        q.choices.length >= 2 && keys.size === q.choices.length && keys.has(q.correctChoiceId),
      );
      graph.questions.push({ position, text: q.text, correct: q.correctChoiceId });
      q.choices.forEach((c, order) => {
        text(c.id);
        text(c.text);
        graph.choices.push({ position, key: c.id, order: order + 1, text: c.text });
      });
      const seen = new Set<string>();
      const answers = resolved.results
        .map((r) => {
          const player = uuid(r.playerId),
            sub = r.submission;
          requireFact(ids.has(player) && !seen.has(player));
          seen.add(player);
          const correct = sub !== null && sub.choiceId === q.correctChoiceId;
          requireFact(r.correct === correct);
          let expected = 0n;
          if (sub) {
            requireFact(
              uuid(sub.playerId) === player &&
                keys.has(sub.choiceId) &&
                [1, 2, 3].includes(sub.attemptCount) &&
                Number.isInteger(sub.finalAnsweredMs) &&
                sub.finalAnsweredMs >= 0 &&
                sub.finalAnsweredMs < 10_000,
            );
            if (correct) expected = correctAnswerScore(sub.attemptCount, sub.finalAnsweredMs);
          }
          requireFact(r.questionScoreUnits === expected);
          totals.set(player, totals.get(player)! + expected);
          return {
            position,
            player,
            selected: sub?.choiceId ?? null,
            attempts: sub?.attemptCount ?? 0,
            elapsed: sub?.finalAnsweredMs ?? null,
            score: score(r.questionScoreUnits),
          };
        })
        .sort((a, b) => (a.player < b.player ? -1 : a.player > b.player ? 1 : 0));
      graph.answers.push(...answers);
    });
    for (const p of participants) {
      requireFact(
        BigInt(p.score) === totals.get(p.player) &&
          p.rank ===
            1 + participants.filter((other) => BigInt(other.score) > BigInt(p.score)).length,
      );
    }
    return graph;
  } catch (error) {
    if (error instanceof CompletionError) throw error;
    throw new CompletionError('INVALID_COMPLETION');
  }
}
