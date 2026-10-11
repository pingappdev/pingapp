import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi } from 'viem';

const state = vi.hoisted(() => ({
  receipt: null as Record<string, unknown> | null,
  hashResults: [] as unknown[][],
  txSelectResults: [] as unknown[][],
  txSelectCount: 0,
  inserted: null as Record<string, unknown> | null,
}));

vi.mock('../src/db/schema.js', () => ({
  contacts: 'contacts', intents: 'intents', routerAuths: 'routerAuths', tokens: 'tokens', transfers: 'transfers', users: 'users',
}));
vi.mock('../src/db/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/db/client.js', () => {
  const query = (result: () => unknown[]) => {
    const chain: Record<string, unknown> = {};
    chain.where = () => chain;
    chain.limit = () => chain;
    chain.for = () => chain;
    chain.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject);
    return chain;
  };
  const tx = {
    select: () => ({ from: () => query(() => {
      state.txSelectCount += 1;
      return state.txSelectResults.shift() ?? [];
    }) }),
    insert: () => ({ values: (values: Record<string, unknown>) => {
      state.inserted = values;
      const insert = {
        onConflictDoNothing: () => insert,
        returning: async () => [{ ...values, id: 'transfer-id' }],
      };
      return insert;
    } }),
  };
  return { db: {
    select: vi.fn(() => ({ from: () => query(() => state.hashResults.shift() ?? []) })),
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(tx)),
  } };
});
vi.mock('drizzle-orm', () => ({
  and: (...values: unknown[]) => values,
  eq: (...values: unknown[]) => values,
  gt: (...values: unknown[]) => values,
  inArray: (...values: unknown[]) => values,
  lt: (...values: unknown[]) => values,
  or: (...values: unknown[]) => values,
  sql: Object.assign((...values: unknown[]) => values, { raw: (value: string) => value }),
}));
vi.mock('drizzle-orm/pg-core', () => ({ alias: (table: unknown, name: string) => ({ table, name }) }));
vi.mock('../src/lib/chain.js', () => ({
  checksum: (value: string) => value,
  explorerTx: (value: string) => `https://explorer.invalid/tx/${value}`,
  isAddress: (value: string) => /^0x[\da-f]{40}$/i.test(value),
  NATIVE_TOKEN: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  normAddress: (value: string) => value.toLowerCase(),
}));
vi.mock('../src/lib/crypto.js', () => ({ phoneHmac: vi.fn((value: string) => value) }));
vi.mock('../src/lib/queue.js', () => ({ enqueue: vi.fn(async () => undefined) }));
vi.mock('../src/lib/viem.js', () => ({ publicClient: {
  getTransactionReceipt: vi.fn(async () => state.receipt),
} }));
vi.mock('../src/modules/phone/lock.js', () => ({ lockPhoneMutation: vi.fn(async () => undefined) }));
vi.mock('../src/modules/tokens/minimum.js', () => ({
  assertMinAmount: vi.fn(async () => undefined), getMinAmountRaw: vi.fn(async () => '1'),
}));
vi.mock('../src/modules/tokens/prices.js', () => ({ getPrices: vi.fn(async () => new Map()) }));
vi.mock('../src/modules/tokens/registry.js', () => ({ getToken: vi.fn(async () => ({
  address: '0x0000000000000000000000000000000000000003', decimals: 6, symbol: 'USDG',
})) }));
vi.mock('../src/modules/tokens/routes.js', () => ({ toTokenDto: vi.fn(() => ({})) }));

import { db } from '../src/db/client.js';
import { phoneHmac } from '../src/lib/crypto.js';
import { publicClient } from '../src/lib/viem.js';
import { recordTransfer } from '../src/modules/transfers/service.js';

const senderAddress = '0x0000000000000000000000000000000000000001';
const recipientAddress = '0x0000000000000000000000000000000000000002';
const tokenAddress = '0x0000000000000000000000000000000000000003';
const txHash = `0x${'55'.repeat(32)}`;

function validReceipt() {
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: {
    from: senderAddress, to: recipientAddress,
  } });
  const data = encodeAbiParameters([{ type: 'uint256' }], [1_000_000n]);
  return {
    status: 'success',
    transactionHash: txHash,
    from: senderAddress,
    logs: [{ address: tokenAddress, topics, data }],
  };
}

describe('transfer identity privacy gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.receipt = null;
    state.hashResults = [];
    state.txSelectResults = [];
    state.txSelectCount = 0;
    state.inserted = null;
  });

  it('rejects an unproven transfer before looking up recipient phone or wallet bindings', async () => {
    state.receipt = {
      status: 'success',
      transactionHash: txHash,
      from: recipientAddress,
      logs: [],
    };

    await expect(recordTransfer({ id: 'sender-id', address: senderAddress }, {
      txHash,
      expectedSenderAddress: senderAddress,
      tokenAddress,
      amountRaw: '1000000',
      toAddress: recipientAddress,
      recipientPhone: '+12025550102',
    })).rejects.toThrow('This transaction does not prove the specified payment.');

    expect(publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash: txHash });
    expect(phoneHmac).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('ignores caller-guessed phone and legacy intent IDs even when reusing a valid paid receipt', async () => {
    state.receipt = validReceipt();
    state.hashResults = [[], []];
    state.txSelectResults = [[{ id: 'sender-id' }], [{ id: 'recipient-id', phoneHmac: 'not-the-submitted-phone' }]];

    const first = await recordTransfer({ id: 'sender-id', address: senderAddress }, {
      txHash,
      expectedSenderAddress: senderAddress,
      tokenAddress,
      amountRaw: '1000000',
      toAddress: recipientAddress,
      recipientPhone: '+12025550102',
      intentId: 'caller-guessed-legacy-intent',
    });

    expect(first.created).toBe(true);
    expect(state.inserted).toMatchObject({ recipientPhoneHmac: null, recipientPhoneMasked: null, intentId: null });
    expect(phoneHmac).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledOnce();

    const saved = { ...(state.inserted as Record<string, unknown>), id: 'transfer-id', senderUserId: 'sender-id' };
    state.hashResults = [[saved]];
    const receiptCallCount = vi.mocked(publicClient.getTransactionReceipt).mock.calls.length;
    const replay = await recordTransfer({ id: 'sender-id', address: senderAddress }, {
      txHash,
      expectedSenderAddress: senderAddress,
      tokenAddress,
      amountRaw: '1000000',
      toAddress: recipientAddress,
      recipientPhone: '+12025550103',
      intentId: 'a-different-guessed-intent',
    });

    expect(replay).toEqual({ row: saved, created: false });
    expect(vi.mocked(publicClient.getTransactionReceipt).mock.calls).toHaveLength(receiptCallCount);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(phoneHmac).not.toHaveBeenCalled();
  });

  it('records a reverted legacy payment without reading or attaching recipient profile metadata', async () => {
    state.receipt = {
      status: 'reverted',
      transactionHash: txHash,
      from: senderAddress,
      logs: [],
    };
    state.hashResults = [[]];
    state.txSelectResults = [[{ id: 'sender-id' }]];

    const result = await recordTransfer({ id: 'sender-id', address: senderAddress }, {
      txHash,
      expectedSenderAddress: senderAddress,
      tokenAddress,
      amountRaw: '1000000',
      toAddress: recipientAddress,
      recipientPhone: '+12025550102',
      intentId: 'caller-guessed-legacy-intent',
    });

    expect(result.created).toBe(true);
    expect(state.txSelectCount).toBe(1); // Sender only; no recipient profile lookup.
    expect(state.inserted).toMatchObject({
      recipientUserId: null,
      recipientPhoneHmac: null,
      recipientPhoneMasked: null,
      intentId: null,
    });
    expect(phoneHmac).not.toHaveBeenCalled();
  });
});
