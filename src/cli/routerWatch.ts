import { createPublicClient, http } from 'viem';
import { parseRouterWatchConfig } from '../modules/escrows/watchConfig.js';
import { ReadOnlyRouterWatchRepository } from '../modules/escrows/watchRepository.js';
import { RouterWatchJournal } from '../modules/escrows/watchJournal.js';
import { postAlert, scanRouterOnce, type WatchChain } from '../modules/escrows/watcher.js';

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function main(): Promise<void> {
  const config = parseRouterWatchConfig();
  const repository = new ReadOnlyRouterWatchRepository(config.databaseUrl);
  const journal = new RouterWatchJournal(config.journalPath, {
    chainId: config.chainId,
    router: config.routerAddress,
    startBlock: config.startBlock,
  });
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const chain = client as unknown as WatchChain;
  const deliver = config.deliveryUrl
    ? (alert: Parameters<typeof postAlert>[2]) => postAlert(config.deliveryUrl!, config.deliveryToken, alert)
    : undefined;
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });
  try {
    await repository.verifyReadOnlyRole();
    while (!stopping) {
      try {
        await scanRouterOnce({ config, chain, repository, journal, ...(deliver ? { deliver } : {}) });
        const state = journal.state();
        process.stdout.write(`[router-watch] next=${state.nextBlock?.toString() ?? config.startBlock.toString()} unacknowledgedAlerts=${state.unacknowledgedAlerts}\n`);
      } catch (error) {
        // Error text can contain RPC or database connection details; never echo it.
        const name = error instanceof Error ? error.name : 'Error';
        if (name === 'RouterWatcherReorgError') {
          process.stderr.write('[router-watch] CRITICAL: checkpoint hash mismatch; scanning paused for operator review\n');
          stopping = true;
          process.exitCode = 1;
          continue;
        }
        process.stderr.write(`[router-watch] cycle failed (${name}); durable cursor retained; retrying\n`);
      }
      if (!stopping) await delay(config.pollMs);
    }
  } finally {
    journal.close();
    await repository.close();
  }
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'Error';
  process.stderr.write(`[router-watch] startup failed (${name})\n`);
  process.exitCode = 1;
});
