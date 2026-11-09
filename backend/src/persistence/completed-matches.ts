import type pg from 'pg';
import type { MatchResult } from '../domain/match-engine.js';
import { CompletionError, durableMatch } from '../application/completed-match.js';
import type { CompletedMatchWriter, DurableMatch } from '../application/completed-match.js';

/** Internal storage readback, never an HTTP History DTO. Uses the same checked-out transaction client. */
export async function readDurableMatch(
  client: Pick<pg.PoolClient, 'query'>,
  id: string,
): Promise<DurableMatch | null> {
  const match = (
    await client.query<{ id: string; host: string; started: Date; finished: Date }>(
      'SELECT id, host_player_id AS host, started_at AS started, finished_at AS finished FROM game_match WHERE id=$1',
      [id],
    )
  ).rows[0];
  if (!match) return null;
  const participants = (
    await client.query<Omit<DurableMatch['participants'][number], 'finished'> & { finished: Date }>(
      'SELECT player_id AS player, finished_at AS finished, final_score_units AS score, final_rank AS rank FROM match_participant WHERE match_id=$1 ORDER BY player_id',
      [id],
    )
  ).rows;
  const questions = (
    await client.query<DurableMatch['questions'][number]>(
      'SELECT question_position AS position, question_text AS text, correct_choice_key AS correct FROM match_question_snapshot WHERE match_id=$1 ORDER BY question_position',
      [id],
    )
  ).rows;
  const choices = (
    await client.query<DurableMatch['choices'][number]>(
      'SELECT question_position AS position, choice_key AS key, display_order AS "order", choice_text AS text FROM match_question_choice_snapshot WHERE match_id=$1 ORDER BY question_position, display_order',
      [id],
    )
  ).rows;
  const answers = (
    await client.query<DurableMatch['answers'][number]>(
      'SELECT question_position AS position, player_id AS player, selected_choice_key AS selected, attempt_count AS attempts, final_answered_ms AS elapsed, question_score_units AS score FROM match_answer_snapshot WHERE match_id=$1 ORDER BY question_position, player_id',
      [id],
    )
  ).rows;
  // pg returns TIMESTAMPTZ as Date, BIGINT as text. Normalize only those representations.
  return {
    match: {
      ...match,
      started: match.started.toISOString(),
      finished: match.finished.toISOString(),
    },
    participants: participants.map((p) => ({ ...p, finished: p.finished.toISOString() })),
    questions,
    choices,
    answers,
  };
}

export class CompletedMatchRepository implements CompletedMatchWriter {
  constructor(private readonly pool: Pick<pg.Pool, 'connect'>) {}
  async save(result: MatchResult): Promise<void> {
    const graph = durableMatch(result);
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new CompletionError('COMPLETION_STORAGE_FAILURE');
    }
    let commitSent = false,
      discard = false;
    try {
      await client.query('BEGIN');
      const m = graph.match;
      const inserted = await client.query(
        'INSERT INTO game_match(id,host_player_id,started_at,finished_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id',
        [m.id, m.host, m.started, m.finished],
      );
      if (!inserted.rowCount) {
        if (JSON.stringify(await readDurableMatch(client, m.id)) !== JSON.stringify(graph))
          throw new CompletionError('COMPLETION_CONFLICT');
      } else {
        for (const p of graph.participants)
          await client.query(
            'INSERT INTO match_participant(match_id,player_id,finished_at,final_score_units,final_rank) VALUES ($1,$2,$3,$4,$5)',
            [m.id, p.player, p.finished, p.score, p.rank],
          );
        for (const q of graph.questions)
          await client.query(
            'INSERT INTO match_question_snapshot(match_id,question_position,question_text,correct_choice_key) VALUES ($1,$2,$3,$4)',
            [m.id, q.position, q.text, q.correct],
          );
        for (const c of graph.choices)
          await client.query(
            'INSERT INTO match_question_choice_snapshot(match_id,question_position,choice_key,display_order,choice_text) VALUES ($1,$2,$3,$4,$5)',
            [m.id, c.position, c.key, c.order, c.text],
          );
        for (const a of graph.answers)
          await client.query(
            'INSERT INTO match_answer_snapshot(match_id,question_position,player_id,selected_choice_key,attempt_count,final_answered_ms,question_score_units) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [m.id, a.position, a.player, a.selected, a.attempts, a.elapsed, a.score],
          );
      }
      commitSent = true;
      await client.query('COMMIT');
    } catch (error) {
      // Even a successful ROLLBACK response cannot disprove an earlier unacknowledged COMMIT.
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      if (error instanceof CompletionError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      // 40003 means statement completion is unknown; do not treat all class-40 errors as aborts.
      const definiteAbort =
        /^23[0-9A-Z]{3}$/.test(code) || ['25P02', '40001', '40P01'].includes(code);
      const unconfirmed = commitSent && !definiteAbort;
      if (unconfirmed) discard = true;
      throw new CompletionError(
        unconfirmed ? 'COMPLETION_UNCONFIRMED' : 'COMPLETION_STORAGE_FAILURE',
      );
    } finally {
      client.release(discard);
    }
  }
}
