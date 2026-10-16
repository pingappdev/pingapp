import { RouterWatchJournal } from '../../src/modules/escrows/watchJournal.js';

const journalPath = process.argv[2];
if (!journalPath) throw new Error('Expected a router watcher journal path.');
const journal = new RouterWatchJournal(journalPath, {
  chainId: 4663,
  router: '0x0000000000000000000000000000000000000003',
  startBlock: 40n,
});
try {
  const state = journal.state();
  process.stdout.write(JSON.stringify({
    nextBlock: state.nextBlock?.toString() ?? null,
    checkpoint: state.checkpoint ? { blockNumber: state.checkpoint.blockNumber.toString(), hash: state.checkpoint.hash } : null,
    pendingAlertIds: state.pendingAlerts.map((alert) => alert.id),
    unacknowledgedAlerts: state.unacknowledgedAlerts,
  }));
} finally {
  journal.close();
}
