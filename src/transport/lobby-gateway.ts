import type { Server, Socket } from 'socket.io';
import type { MatchCoordinator, CommandReceipt } from '../application/match-coordinator.js';
import type { PlayerProfile } from '../application/authenticate-player.js';
import { presentLobby } from '../application/lobby-presenter.js';
import type { Authentication } from './authentication.js';
import { sessionToken } from './auth-policy.js';

export interface CreateMatchRequest {
  commandId: string;
  payload: Record<string, never>;
}
export interface LobbyMatchRequest {
  commandId: string;
  payload: { matchId: string };
}
export type LobbyAcknowledgement =
  | { commandId: string; status: 'accepted'; matchId: string; version: number }
  | {
      commandId: string;
      status: 'rejected';
      matchId: string;
      version?: number;
      error: { code: string };
    }
  | {
      commandId: string | null;
      status: 'error';
      error: { code: 'INVALID_REQUEST' | 'UNAUTHENTICATED' | 'LOBBY_UNAVAILABLE' };
    };

export interface LobbyRuntime {
  coordinator: MatchCoordinator;
  players: { findPlayerById(playerId: string): Promise<PlayerProfile | null> };
}
type Event = 'CreateMatch' | 'JoinMatch' | 'LeaveMatch';
type Subscription = { playerId: string; version: number };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function validRequest(
  event: Event,
  value: unknown,
): value is CreateMatchRequest | LobbyMatchRequest {
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    !identity(value.commandId) ||
    !record(value.payload)
  )
    return false;
  return event === 'CreateMatch'
    ? Object.keys(value.payload).length === 0
    : Object.keys(value.payload).length === 1 && identity(value.payload.matchId);
}
function acknowledgement(commandId: string, receipt: CommandReceipt): LobbyAcknowledgement {
  const result = receipt.outcome;
  if (result.status === 'missing')
    return { commandId, status: 'rejected', matchId: result.matchId, error: { code: result.code } };
  const matchId = result.match.id,
    version = result.match.version;
  return result.status === 'accepted'
    ? { commandId, status: 'accepted', matchId, version }
    : {
        commandId,
        status: 'rejected',
        matchId,
        version,
        error: { code: result.status === 'rejected' ? result.code : result.reason },
      };
}

export function installLobbyGateway(
  io: Server,
  auth: Authentication,
  runtime: LobbyRuntime,
  reportFailure: (
    code: 'LOBBY_COMMAND_FAILURE' | 'LOBBY_PROFILE_FAILURE',
    matchId?: string,
  ) => void,
): () => void {
  const { coordinator, players } = runtime;
  const subscriptions = new Map<Socket, Map<string, Subscription>>();
  // Coordinator retries return the original Promise. A replay must never apply socket effects again.
  const observed = new WeakSet<Promise<CommandReceipt>>();
  // Only the latest in-flight version per Match is retained, never retry promises.
  const publishing = new Map<string, number>();
  let closed = false;

  function publish(matchId: string): void {
    if (closed) return;
    const found = coordinator.lookup(matchId);
    if (found.status !== 'found' || found.match.phase !== 'WAITING') return;
    const match = found.match;
    if (publishing.get(matchId) === match.version) return;
    let needed = false;
    for (const [socket, set] of subscriptions) {
      const subscription = set.get(matchId);
      if (
        socket.connected &&
        subscription &&
        subscription.version < match.version &&
        match.participants.includes(subscription.playerId)
      ) {
        needed = true;
        break;
      }
    }
    if (!needed) return;
    publishing.set(matchId, match.version);
    void (async () => {
      try {
        const profiles = await Promise.all(
          match.participants.map((id) => players.findPlayerById(id)),
        );
        if (closed) return;
        const current = coordinator.lookup(matchId);
        if (current.status !== 'found' || current.match.phase !== 'WAITING') return;
        if (current.match !== match) {
          publish(matchId); // Regenerate only for a real newer commit.
          return;
        }
        if (profiles.some((profile) => profile === null)) throw new Error('Missing lobby profile');
        const snapshot = presentLobby(match, profiles as PlayerProfile[]);
        for (const [socket, set] of subscriptions) {
          const token = sessionToken(socket.request.headers.cookie, auth.policy);
          await auth.sessions.inspect(token, (player) => {
            const latest = coordinator.lookup(matchId);
            const subscription = set.get(matchId);
            if (closed || !socket.connected || !subscription || subscription.playerId !== player.id)
              return;
            if (latest.status !== 'found' || !latest.match.participants.includes(player.id)) {
              set.delete(matchId);
              return;
            }
            if (latest.match !== match || subscription.version >= match.version) return;
            subscription.version = match.version;
            socket.emit('LobbySnapshot', snapshot);
          });
        }
        const latest = coordinator.lookup(matchId);
        if (latest.status === 'found' && latest.match !== match) publish(matchId);
      } catch {
        reportFailure('LOBBY_PROFILE_FAILURE', matchId);
      } finally {
        // An obsolete completion must not clear a newer version's in-flight marker.
        if (publishing.get(matchId) === match.version) publishing.delete(matchId);
      }
    })();
  }

  io.on('connection', (socket) => {
    const set = new Map<string, Subscription>();
    subscriptions.set(socket, set);
    socket.once('disconnect', () => subscriptions.delete(socket));
    for (const event of ['CreateMatch', 'JoinMatch', 'LeaveMatch'] as const) {
      socket.on(event, (value: unknown, callback: unknown) => {
        const commandId =
          record(value) && typeof value.commandId === 'string' ? value.commandId : null;
        const reply = (ack: LobbyAcknowledgement) => {
          if (typeof callback === 'function') callback(ack);
        };
        if (!validRequest(event, value)) {
          reply({ commandId, status: 'error', error: { code: 'INVALID_REQUEST' } });
          return;
        }
        if (closed) {
          reply({ commandId, status: 'error', error: { code: 'LOBBY_UNAVAILABLE' } });
          return;
        }
        const token = sessionToken(socket.request.headers.cookie, auth.policy);
        // The callback admits immediately. Neither SQL nor an await can enter this boundary.
        void auth.sessions
          .act(token, (player) => {
            const operation =
              event === 'CreateMatch'
                ? coordinator.create(player.id, value.commandId)
                : coordinator.dispatch(player.id, value.commandId, {
                    type: event === 'JoinMatch' ? 'join' : 'leave',
                    matchId: (value as LobbyMatchRequest).payload.matchId,
                  });
            const first = !observed.has(operation);
            observed.add(operation);
            // Attach synchronously at admission, so subscription effects follow commit order.
            return operation.then((receipt) => {
              const result = receipt.outcome;
              if (!closed && first && result.status === 'accepted' && result.changed) {
                const matchId = result.match.id;
                if (event === 'LeaveMatch') {
                  // Leaving removes membership for the Player, invalidating any older socket subscription.
                  for (const entries of subscriptions.values())
                    if (entries.get(matchId)?.playerId === player.id) entries.delete(matchId);
                } else if (socket.connected) {
                  set.set(matchId, { playerId: player.id, version: 0 });
                }
              }
              reply(acknowledgement(value.commandId, receipt));
              if (!closed && result.status !== 'missing') publish(result.match.id);
            });
          })
          .then((admitted) => {
            if (!admitted)
              reply({ commandId, status: 'error', error: { code: 'UNAUTHENTICATED' } });
            return admitted?.value;
          })
          .catch(() => {
            reportFailure('LOBBY_COMMAND_FAILURE');
            reply({ commandId, status: 'error', error: { code: 'LOBBY_UNAVAILABLE' } });
          });
      });
    }
  });
  return () => {
    closed = true;
    subscriptions.clear();
    publishing.clear();
  };
}
