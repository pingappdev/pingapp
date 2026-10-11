import { describe, expect, it, vi } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const fixture = await vi.hoisted(async () => {
  const { generatePrivateKey } = await import('viem/accounts');
  return { key: generatePrivateKey() };
});
vi.mock('../src/config.js', async (original) => {
  const { config } = await original<typeof import('../src/config.js')>();
  return { config: { ...config, ROUTER_SIGNER_KEY: fixture.key.slice(2), ROUTER_ADDRESS: '0x0000000000000000000000000000000000000010' } };
});
import { claimAuthTypes, escrowAuthTypes, newRouterId, pingRouterAbi, routerDomain, serializeRouterAuth,
  sendAuthTypes, signClaimAuth, signEscrowAuth, signSendAuth } from '../src/lib/router.js';

const sender = '0x0000000000000000000000000000000000000001' as const;
const recipient = '0x0000000000000000000000000000000000000002' as const;
const token = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const;
const common = { id: newRouterId(), sender, token, amount: 1000000000000000n, deadline: 1900000000n };

describe('router typed authorizations', () => {
  it('recovers SendAuth from the configured signer', async () => {
    const message = { ...common, recipient };
    const signature = await signSendAuth(message);
    expect(await recoverTypedDataAddress({ domain: routerDomain, types: sendAuthTypes, primaryType: 'SendAuth', message, signature }))
      .toBe(privateKeyToAccount(fixture.key).address);
  });
  it('recovers EscrowAuth from the configured signer', async () => {
    const message = { ...common, claimTip: 20000000000000n, expiresAt: 1901209600n };
    const signature = await signEscrowAuth(message);
    expect(await recoverTypedDataAddress({ domain: routerDomain, types: escrowAuthTypes, primaryType: 'EscrowAuth', message, signature }))
      .toBe(privateKeyToAccount(fixture.key).address);
    expect(serializeRouterAuth(message)).toMatchObject({ amount: common.amount.toString(), claimTip: '20000000000000', expiresAt: '1901209600' });
  });
  it('binds the claim recipient and relayer', async () => {
    const message = { id: common.id, recipient, relayer: sender, deadline: common.deadline };
    const signature = await signClaimAuth(message);
    expect(await recoverTypedDataAddress({ domain: routerDomain, types: claimAuthTypes, primaryType: 'ClaimAuth', message, signature }))
      .toBe(privateKeyToAccount(fixture.key).address);
    expect(await recoverTypedDataAddress({ domain: routerDomain, types: claimAuthTypes, primaryType: 'ClaimAuth',
      message: { ...message, recipient: sender }, signature })).not.toBe(privateKeyToAccount(fixture.key).address);
    expect(await recoverTypedDataAddress({ domain: routerDomain, types: claimAuthTypes, primaryType: 'ClaimAuth',
      message: { ...message, relayer: recipient }, signature })).not.toBe(privateKeyToAccount(fixture.key).address);
  });
  it.each([
    ['send', sendAuthTypes.SendAuth], ['escrow', escrowAuthTypes.EscrowAuth], ['claim', claimAuthTypes.ClaimAuth],
  ] as const)('%s fields and order match the compiled ABI', (name, fields) => {
    const entry = pingRouterAbi.find((item) => item.type === 'function' && item.name === name);
    const input = entry?.type === 'function' ? entry.inputs[0] : undefined;
    if (!input || !('components' in input)) throw new Error('Missing authorization tuple');
    expect(fields).toEqual(input.components.map(({ name, type }) => ({ name, type })));
  });
  it('generates independent 32-byte random identifiers', () => {
    const ids = new Set(Array.from({ length: 100 }, newRouterId));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
