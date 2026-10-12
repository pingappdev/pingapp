import { inArray } from 'drizzle-orm';
import { zeroAddress, type Address, type Hex } from 'viem';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { kvGet, kvSet } from '../../db/kv.js';
import { escrows } from '../../db/schema.js';
import { NATIVE_TOKEN, normAddress } from '../../lib/chain.js';
import { logger } from '../../lib/logger.js';
import { pingRouterAbi } from '../../lib/router.js';
import { publicClient } from '../../lib/viem.js';

/** Tokens whose router balance is below its open obligations; new sends of them are refused. */
export const insolventTokensKey = 'router:insolvent-tokens';

const erc20BalanceAbi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] as const;

export async function isTokenInsolvent(token: string): Promise<boolean> {
  return (await kvGet<string[]>(insolventTokensKey) ?? []).includes(normAddress(token));
}

/**
 * Escrows of one token share the router's balance, so a token that later charges
 * transfer fees (or a proxy upgrade) can leave the last claimer short. Every read
 * uses one block, and obligations come from the chain itself, so indexing lag
 * cannot cause false alarms.
 */
export async function checkSolvency(): Promise<void> {
  if (!config.ROUTER_ENABLED) return;
  const router = normAddress(config.ROUTER_ADDRESS);
  try {
    const rows = await db.select({ id: escrows.id }).from(escrows)
      .where(inArray(escrows.status, ['authorized', 'deposited', 'claiming']));
    const blockNumber = await publicClient.getBlockNumber();
    const [feesAccrued, totalOwed, ...open] = await Promise.all([
      publicClient.readContract({ address: router, abi: pingRouterAbi, functionName: 'feesAccrued', blockNumber }),
      publicClient.readContract({ address: router, abi: pingRouterAbi, functionName: 'totalOwed', blockNumber }),
      ...rows.map((row) => publicClient.readContract({ address: router, abi: pingRouterAbi, functionName: 'escrows',
        args: [row.id as Hex], blockNumber })),
    ]);
    const required = new Map<string, bigint>([[NATIVE_TOKEN, feesAccrued + totalOwed]]);
    for (const [sender, , token, amount, claimTip] of open) {
      if (sender === zeroAddress) continue;
      const key = normAddress(token);
      required.set(NATIVE_TOKEN, required.get(NATIVE_TOKEN)! + claimTip);
      required.set(key, (required.get(key) ?? 0n) + amount);
    }
    const short: string[] = [];
    for (const [token, needed] of required) {
      const balance = token === NATIVE_TOKEN
        ? await publicClient.getBalance({ address: router, blockNumber })
        : await publicClient.readContract({ address: token as Address, abi: erc20BalanceAbi, functionName: 'balanceOf',
          args: [router], blockNumber });
      if (balance < needed) {
        short.push(token);
        logger.error({ token, required: needed.toString(), balance: balance.toString(), blockNumber: blockNumber.toString() },
          'router token balance below open escrows; new sends of this token are paused');
      }
    }
    await kvSet(insolventTokensKey, short);
  } catch (error) {
    // Keep the previous verdict rather than unpausing on a failed read.
    logger.warn({ err: error }, 'router solvency check failed');
  }
}
