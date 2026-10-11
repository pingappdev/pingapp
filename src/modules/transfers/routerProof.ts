import { decodeEventLog, type TransactionReceipt } from 'viem';
import { config } from '../../config.js';
import type { Transfer } from '../../db/schema.js';
import { normAddress } from '../../lib/chain.js';
import { pingRouterAbi } from '../../lib/pingRouterAbi.js';

export function hasRouterSentLog(receipt: Pick<TransactionReceipt, 'logs'>, row: Pick<Transfer,
  'routerId' | 'senderAddress' | 'recipientAddress' | 'tokenAddress' | 'amountRaw'
>): boolean {
  for (const log of receipt.logs) {
    if (normAddress(log.address) !== normAddress(config.ROUTER_ADDRESS)) continue;
    try {
      const { args } = decodeEventLog({ abi: pingRouterAbi, eventName: 'Sent', data: log.data, topics: log.topics });
      if (args.id === row.routerId && normAddress(args.sender) === row.senderAddress &&
          normAddress(args.recipient) === row.recipientAddress && normAddress(args.token) === row.tokenAddress &&
          args.amount === BigInt(row.amountRaw)) return true;
    } catch {
      // Malformed and unrelated logs never prove delivery.
    }
  }
  return false;
}
