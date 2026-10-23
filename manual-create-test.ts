
import { MatchCoordinator } from './src/application/match-coordinator.js';
import { SystemClock, NodeMatchScheduler } from './src/runtime/match-time.js';

const clock = new SystemClock();
const scheduler = new NodeMatchScheduler(clock);
let generated = 0;

const coordinator = new MatchCoordinator(
  clock,
  scheduler,
  () => `manual-match-${++generated}`,
);

function show(label: string, receipt: Awaited<ReturnType<typeof coordinator.create>>) {
  const outcome = receipt.outcome;
  console.log(label, {
    receivedAt: receipt.receivedAt,
    sequence: receipt.receiptSequence,
    status: outcome.status,
    version: outcome.status === 'missing' ? null : outcome.match.version,
    participants: outcome.status === 'missing' ? null : outcome.match.participants,
  });
}

try {
  const created = await coordinator.create('host', 'create-001');
  const matchId = created.outcome.status === 'missing'
    ? ''
    : created.outcome.match.id;

  console.log('--- DISPATCH WITHOUT AWAIT ---');

  const p1 = coordinator.dispatch('player-A', 'join-001', {
    type: 'join', matchId,
  });

  const p2 = coordinator.dispatch('player-B', 'join-002', {
    type: 'join', matchId,
  });

  const p3 = coordinator.dispatch('player-A', 'join-001', {
    type: 'join', matchId,
  });

  console.log('p1 === p3:', p1 === p3);

  const [a, b, c] = await Promise.all([p1, p2, p3]);

  show('A', a);
  show('B', b);
  show('C (retry)', c);

  console.log('a === c:', a === c);

  const lookup = coordinator.lookup(matchId);
  console.log('--- FINAL REGISTRY ---');
  console.log(lookup);
} finally {
  await coordinator.shutdown();
}
