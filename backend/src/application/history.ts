export interface HistoryPosition {
  finishedAt: string;
  matchId: string;
}
export interface HistoryPageRequest {
  limit: number;
  cursor?: HistoryPosition;
}
export interface HistoryItem extends HistoryPosition {
  ownResult: { score: { scoreUnits: string }; rank: number };
  participantCount: number;
}
export interface HistoryList {
  items: HistoryItem[];
  nextCursor: string | null;
}
export interface HistoryDetail {
  match: { matchId: string; startedAt: string; finishedAt: string; hostPlayerId: string };
  participants: {
    playerId: string;
    displayName: string;
    score: { scoreUnits: string };
    rank: number;
  }[];
  questions: {
    questionNumber: number;
    text: string;
    choices: { choiceId: string; text: string }[];
    correctChoiceId: string;
    ownResult: {
      selectedChoiceId: string | null;
      attemptCount: number;
      finalAnsweredMs: number | null;
      score: { scoreUnits: string };
    };
  }[];
}
export interface HistoryReader {
  listForPlayer(playerId: string, page: HistoryPageRequest): Promise<HistoryList>;
  findDetailForPlayer(playerId: string, matchId: string): Promise<HistoryDetail | null>;
}
export class HistoryError extends Error {
  constructor(readonly code: 'HISTORY_UNAVAILABLE' | 'HISTORY_INTEGRITY_FAILURE') {
    super(code);
  }
}

export function isHistoryUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function invalid(): never {
  throw new TypeError('INVALID_REQUEST');
}
export function encodeHistoryCursor(position: HistoryPosition): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      finishedAt: position.finishedAt,
      matchId: position.matchId.toLowerCase(),
    }),
  ).toString('base64url');
}
export function historyPage(query: unknown): HistoryPageRequest {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return invalid();
  const fields = query as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== 'limit' && key !== 'cursor')) return invalid();
  const limit = fields.limit === undefined ? 20 : fields.limit;
  if (typeof limit !== 'number' && (typeof limit !== 'string' || !/^[1-9]\d?$/.test(limit)))
    return invalid();
  const size = Number(limit);
  if (!Number.isInteger(size) || size < 1 || size > 50) return invalid();
  if (fields.cursor === undefined) return { limit: size };
  const encoded = fields.cursor;
  if (typeof encoded !== 'string' || encoded.length > 512 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    return invalid();
  try {
    const buffer = Buffer.from(encoded, 'base64url');
    if (buffer.toString('base64url') !== encoded) return invalid();
    const raw: unknown = JSON.parse(buffer.toString('utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
    const cursor = raw as Record<string, unknown>;
    if (
      Object.keys(cursor).length !== 3 ||
      cursor.v !== 1 ||
      !isHistoryUuid(cursor.matchId) ||
      cursor.matchId !== cursor.matchId.toLowerCase() ||
      typeof cursor.finishedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.finishedAt) ||
      new Date(cursor.finishedAt).toISOString() !== cursor.finishedAt
    )
      return invalid();
    const position = { finishedAt: cursor.finishedAt, matchId: cursor.matchId };
    // A single canonical encoding also rejects duplicate JSON keys/invalid UTF-8.
    if (encodeHistoryCursor(position) !== encoded) return invalid();
    return { limit: size, cursor: position };
  } catch {
    return invalid();
  }
}
