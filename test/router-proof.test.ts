import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex, type TransactionReceipt } from 'viem';
vi.mock('../src/config.js', async (original) => {
  const { config } = await original<typeof import('../src/config.js')>();
  return { config: { ...config, ROUTER_ADDRESS: '0x0000000000000000000000000000000000000010' } };
});
import { pingRouterAbi } from '../src/lib/pingRouterAbi.js';
import { hasRouterSentLog } from '../src/modules/transfers/routerProof.js';

const router = '0x0000000000000000000000000000000000000010';
const row = { routerId: `0x${'01'.repeat(32)}`, senderAddress: '0x0000000000000000000000000000000000000001',
  recipientAddress: '0x0000000000000000000000000000000000000002', tokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', amountRaw: '100' };
function receipt(overrides: Partial<typeof row> = {}, address = router) {
  const fields = { ...row, ...overrides };
  const topics = encodeEventTopics({ abi: pingRouterAbi, eventName: 'Sent', args: {
    id: fields.routerId as Hex, sender: fields.senderAddress as Hex, recipient: fields.recipientAddress as Hex,
  } });
  const data = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [fields.tokenAddress as Hex, BigInt(fields.amountRaw)]);
  return { logs: [{ address, topics, data }] as unknown as TransactionReceipt['logs'] };
}
describe('router receipt proof', () => {
  it('accepts the exact router event', () => expect(hasRouterSentLog(receipt(), row)).toBe(true));
  it('rejects another emitting contract', () => expect(hasRouterSentLog(receipt({}, row.senderAddress), row)).toBe(false));
  it.each([
    { routerId: `0x${'02'.repeat(32)}` }, { senderAddress: row.recipientAddress },
    { recipientAddress: row.senderAddress }, { tokenAddress: row.senderAddress }, { amountRaw: '101' },
  ])('rejects mismatched signed fields: %j', (mutation) => expect(hasRouterSentLog(receipt(mutation), row)).toBe(false));
  it('rejects malformed logs', () => {
    const logs = receipt(); logs.logs[0].data = '0x';
    expect(hasRouterSentLog(logs, row)).toBe(false);
  });
});
