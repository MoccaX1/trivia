import type pg from 'pg';
import { HistoryError, encodeHistoryCursor, isHistoryUuid } from '../application/history.js';
import type {
  HistoryReader,
  HistoryPageRequest,
  HistoryList,
  HistoryDetail,
} from '../application/history.js';

function fact(valid: boolean): asserts valid {
  if (!valid) throw new HistoryError('HISTORY_INTEGRITY_FAILURE');
}
function timestamp(value: Date): string {
  fact(value instanceof Date && Number.isFinite(value.getTime()));
  return value.toISOString();
}
function units(value: string): string {
  fact(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value));
  return value;
}
function storage(error: unknown): never {
  if (error instanceof HistoryError) throw error;
  throw new HistoryError('HISTORY_UNAVAILABLE');
}

/** Committed participant-authorized reads; never reads Registry or other players' answers. */
export class HistoryRepository implements HistoryReader {
  constructor(private readonly pool: Pick<pg.Pool, 'connect'>) {}

  async listForPlayer(playerId: string, page: HistoryPageRequest): Promise<HistoryList> {
    if (
      !isHistoryUuid(playerId) ||
      !Number.isInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > 50
    )
      throw new TypeError('Invalid History input');
    let client: pg.PoolClient | undefined;
    try {
      client = await this.pool.connect();
      const cursor = page.cursor;
      const rows = (
        await client.query<{
          match_id: string;
          finished_at: Date;
          final_score_units: string;
          final_rank: number;
        }>(
          `SELECT match_id, finished_at, final_score_units, final_rank FROM match_participant
         WHERE player_id=$1 ${cursor ? 'AND (finished_at,match_id)<($2::timestamptz,$3::uuid)' : ''}
         ORDER BY finished_at DESC,match_id DESC LIMIT $${cursor ? 4 : 2}`,
          cursor
            ? [playerId, cursor.finishedAt, cursor.matchId, page.limit + 1]
            : [playerId, page.limit + 1],
        )
      ).rows;
      const returned = rows.slice(0, page.limit);
      // Count only this bounded page, not the whole History or the look-ahead row.
      const counts = returned.length
        ? (
            await client.query<{ match_id: string; count: number }>(
              'SELECT match_id, count(*)::int AS count FROM match_participant WHERE match_id=ANY($1::uuid[]) GROUP BY match_id',
              [returned.map((row) => row.match_id)],
            )
          ).rows
        : [];
      const countById = new Map(counts.map((row) => [row.match_id, row.count]));
      const items = returned.map((row) => {
        const count = countById.get(row.match_id);
        fact(
          count !== undefined &&
            count >= 2 &&
            count <= 10 &&
            row.final_rank >= 1 &&
            row.final_rank <= count,
        );
        return {
          matchId: row.match_id,
          finishedAt: timestamp(row.finished_at),
          ownResult: { score: { scoreUnits: units(row.final_score_units) }, rank: row.final_rank },
          participantCount: count,
        };
      });
      return {
        items,
        nextCursor: rows.length > page.limit ? encodeHistoryCursor(items.at(-1)!) : null,
      };
    } catch (error) {
      return storage(error);
    } finally {
      client?.release();
    }
  }

  async findDetailForPlayer(playerId: string, matchId: string): Promise<HistoryDetail | null> {
    if (!isHistoryUuid(playerId) || !isHistoryUuid(matchId))
      throw new TypeError('Invalid History input');
    let client: pg.PoolClient | undefined;
    try {
      client = await this.pool.connect();
      const match = (
        await client.query<{
          id: string;
          host_player_id: string;
          started_at: Date;
          finished_at: Date;
        }>(
          `SELECT m.id,m.host_player_id,m.started_at,m.finished_at FROM game_match m
         JOIN match_participant own ON own.match_id=m.id AND own.player_id=$1 WHERE m.id=$2`,
          [playerId, matchId],
        )
      ).rows[0];
      if (!match) return null;
      const participants = (
        await client.query<{
          player_id: string;
          display_name: string | null;
          final_score_units: string;
          final_rank: number;
          finished_at: Date;
        }>(
          `SELECT mp.player_id,p.display_name,mp.final_score_units,mp.final_rank,mp.finished_at
         FROM match_participant mp LEFT JOIN player p ON p.id=mp.player_id
         WHERE mp.match_id=$1 ORDER BY mp.final_score_units DESC,mp.player_id`,
          [matchId],
        )
      ).rows;
      const questions = (
        await client.query<{
          question_position: number;
          question_text: string;
          correct_choice_key: string;
        }>(
          'SELECT question_position,question_text,correct_choice_key FROM match_question_snapshot WHERE match_id=$1 ORDER BY question_position',
          [matchId],
        )
      ).rows;
      const choices = (
        await client.query<{
          question_position: number;
          choice_key: string;
          display_order: number;
          choice_text: string;
        }>(
          'SELECT question_position,choice_key,display_order,choice_text FROM match_question_choice_snapshot WHERE match_id=$1 ORDER BY question_position,display_order',
          [matchId],
        )
      ).rows;
      const answers = (
        await client.query<{
          question_position: number;
          selected_choice_key: string | null;
          attempt_count: number;
          final_answered_ms: number | null;
          question_score_units: string;
        }>(
          `SELECT question_position,selected_choice_key,attempt_count,final_answered_ms,question_score_units
         FROM match_answer_snapshot WHERE match_id=$1 AND player_id=$2 ORDER BY question_position`,
          [matchId, playerId],
        )
      ).rows;
      const startedAt = timestamp(match.started_at),
        finishedAt = timestamp(match.finished_at);
      fact(
        match.started_at < match.finished_at &&
          participants.length >= 2 &&
          participants.length <= 10,
      );
      fact(participants.some((p) => p.player_id === match.host_player_id));
      fact(questions.length === 10 && answers.length === 10);
      const publicParticipants = participants.map((p) => {
        fact(
          typeof p.display_name === 'string' &&
            p.display_name.trim().length > 0 &&
            timestamp(p.finished_at) === finishedAt,
        );
        const score = units(p.final_score_units);
        fact(
          p.final_rank ===
            1 +
              participants.filter((other) => BigInt(units(other.final_score_units)) > BigInt(score))
                .length,
        );
        return {
          playerId: p.player_id,
          displayName: p.display_name,
          score: { scoreUnits: score },
          rank: p.final_rank,
        };
      });
      let ownTotal = 0n;
      const publicQuestions = questions.map((q, index) => {
        fact(q.question_position === index + 1 && q.question_text.trim().length > 0);
        const presented = choices.filter((c) => c.question_position === q.question_position);
        fact(presented.length >= 2 && presented.some((c) => c.choice_key === q.correct_choice_key));
        const publicChoices = presented.map((c, order) => {
          fact(
            c.display_order === order + 1 &&
              c.choice_key.trim().length > 0 &&
              c.choice_text.trim().length > 0,
          );
          return { choiceId: c.choice_key, text: c.choice_text };
        });
        const a = answers[index]!;
        fact(a.question_position === q.question_position);
        const award = units(a.question_score_units);
        if (a.selected_choice_key === null)
          fact(a.attempt_count === 0 && a.final_answered_ms === null && award === '0');
        else {
          fact(
            presented.some((c) => c.choice_key === a.selected_choice_key) &&
              a.attempt_count >= 1 &&
              a.attempt_count <= 3 &&
              a.final_answered_ms !== null &&
              a.final_answered_ms >= 0 &&
              a.final_answered_ms < 10000,
          );
          if (a.selected_choice_key !== q.correct_choice_key) fact(award === '0');
        }
        ownTotal += BigInt(award);
        return {
          questionNumber: q.question_position,
          text: q.question_text,
          choices: publicChoices,
          correctChoiceId: q.correct_choice_key,
          ownResult: {
            selectedChoiceId: a.selected_choice_key,
            attemptCount: a.attempt_count,
            finalAnsweredMs: a.final_answered_ms,
            score: { scoreUnits: award },
          },
        };
      });
      fact(choices.length === publicQuestions.reduce((count, q) => count + q.choices.length, 0));
      const own = publicParticipants.find((p) => p.playerId === playerId.toLowerCase());
      fact(own !== undefined && BigInt(own.score.scoreUnits) === ownTotal);
      return {
        match: { matchId: match.id, startedAt, finishedAt, hostPlayerId: match.host_player_id },
        participants: publicParticipants,
        questions: publicQuestions,
      };
    } catch (error) {
      return storage(error);
    } finally {
      client?.release();
    }
  }
}
