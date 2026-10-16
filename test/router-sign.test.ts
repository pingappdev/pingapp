import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const fixture = await vi.hoisted(async () => {
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
  const key = generatePrivateKey();
  process.env.ROUTER_SIGNER_KEY = key.slice(2);
  const config = {
    NODE_ENV: 'test', LOG_LEVEL: 'silent', IP_HASH_SALT: 'router-sign-test',
    CHAIN: 'robinhood-testnet', ALCHEMY_API_KEYS: [], PUBLIC_RPC_URL: 'http://127.0.0.1:8545',
    ROUTER_ENABLED: true, ROUTER_NEW_AUTHORIZATIONS_ENABLED: true, ROUTER_NEW_CLAIM_SIGNATURES_ENABLED: true,
    ROUTER_RELAY_BROADCASTS_ENABLED: true, ROUTER_ADDRESS: '0x0000000000000000000000000000000000000010',
    ROUTER_AUTH_TTL_SECONDS: 600,
  };
  const assertReady = vi.fn(() => ({ address: privateKeyToAccount(key).address, generation: 1 }));
  return { key, config, assertReady };
});
vi.mock('../src/config.js', () => ({ config: fixture.config }));
vi.mock('../src/lib/routerStartup.js', () => ({
  readRouterSettings: vi.fn(),
  assertRouterSigningReady: fixture.assertReady,
}));
import { claimAuthTypes, escrowAuthTypes, hashClaimAuth, newRouterId, pingRouterAbi, routerDomain, serializeRouterAuth,
  sendAuthTypes, signClaimAuth, signEscrowAuth, signSendAuth } from '../src/lib/router.js';

const sender = '0x0000000000000000000000000000000000000001' as const;
const recipient = '0x0000000000000000000000000000000000000002' as const;
const token = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const;
const future = (seconds: number) => BigInt(Math.floor(Date.now() / 1000) + seconds);
const common = () => ({ id: newRouterId(), sender, token, amount: 1000000000000000n, deadline: future(300) });

describe('router typed authorizations', () => {
  beforeEach(() => {
    fixture.assertReady.mockReset().mockImplementation(() => ({ address: privateKeyToAccount(fixture.key).address, generation: 1 }));
    fixture.config.ROUTER_ENABLED = true;
    fixture.config.ROUTER_NEW_AUTHORIZATIONS_ENABLED = true;
    fixture.config.ROUTER_NEW_CLAIM_SIGNATURES_ENABLED = true;
  });

  it('recovers SendAuth from the configured signer', async () => {
    const message = { ...common(), recipient };
    const signature = await signSendAuth(message);
    expect(await recoverTypedDataAddress({ domain: routerDomain, types: sendAuthTypes, primaryType: 'SendAuth', message, signature }))
      .toBe(privateKeyToAccount(fixture.key).address);
  });
  it('does not allow a caller-supplied domain to change the production signing domain', async () => {
    const message = { ...common(), recipient };
    const alternateDomain = { ...routerDomain, verifyingContract: '0x0000000000000000000000000000000000000099' as const };
    const signature = await (signSendAuth as (...args: any[]) => Promise<`0x${string}`>)(message, alternateDomain);
    expect(await recoverTypedDataAddress({ domain: routerDomain, types: sendAuthTypes, primaryType: 'SendAuth', message, signature }))
      .toBe(privateKeyToAccount(fixture.key).address);
    expect(await recoverTypedDataAddress({ domain: alternateDomain, types: sendAuthTypes, primaryType: 'SendAuth', message, signature }))
      .not.toBe(privateKeyToAccount(fixture.key).address);
  });
  it('recovers EscrowAuth from the configured signer', async () => {
    const message = { ...common(), claimTip: 20000000000000n, expiresAt: future(14 * 86400) };
    const signature = await signEscrowAuth(message);
    expect(await recoverTypedDataAddress({ domain: routerDomain, types: escrowAuthTypes, primaryType: 'EscrowAuth', message, signature }))
      .toBe(privateKeyToAccount(fixture.key).address);
    expect(serializeRouterAuth(message)).toMatchObject({ amount: message.amount.toString(), claimTip: '20000000000000', expiresAt: message.expiresAt.toString() });
  });
  it('binds the claim recipient and relayer', async () => {
    const message = { id: newRouterId(), recipient, relayer: sender, deadline: future(300) };
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

  it('rejects zero, reused-recipient, or empty send authorization values', async () => {
    const auth = { ...common(), recipient };
    await expect(signSendAuth({ ...auth, amount: 0n })).rejects.toThrow('amount');
    await expect(signSendAuth({ ...auth, recipient: sender })).rejects.toThrow('recipient');
    await expect(signSendAuth({ ...auth, recipient: '0x0000000000000000000000000000000000000000' as const })).rejects.toThrow('recipient');
    await expect(signSendAuth({ ...auth, id: `0x${'00'.repeat(32)}` as const })).rejects.toThrow('id');
  });

  it('bounds send deadlines and escrow amount, tip, and lifetime to router limits', async () => {
    const send = { ...common(), recipient };
    await expect(signSendAuth({ ...send, deadline: future(601) })).rejects.toThrow('deadline');
    await expect(signEscrowAuth({ ...common(), claimTip: 1_000_000_000_000_001n, expiresAt: future(14 * 86400) }))
      .rejects.toThrow('claim tip');
    await expect(signEscrowAuth({ ...common(), claimTip: 0n, expiresAt: future(60 * 86400 + 1) })).rejects.toThrow('expiry');
    await expect(signEscrowAuth({ ...common(), amount: 0n, claimTip: 0n, expiresAt: future(14 * 86400) })).rejects.toThrow('amount');
  });

  it('rejects zero relayer, zero recipient and long-lived claim authorizations', async () => {
    const auth = { id: newRouterId(), recipient, relayer: '0x0000000000000000000000000000000000000000' as const, deadline: future(300) };
    await expect(signClaimAuth(auth)).rejects.toThrow('relayer');
    await expect(signClaimAuth({ ...auth, relayer: sender, recipient: '0x0000000000000000000000000000000000000000' as const })).rejects.toThrow('recipient');
    await expect(signClaimAuth({ ...auth, relayer: sender, deadline: future(601) })).rejects.toThrow('deadline');
  });

  it('hashes historical claim authorization data without current-time signing policy', () => {
    const auth = { id: newRouterId(), recipient, relayer: sender, deadline: 1n };
    expect(hashClaimAuth(auth)).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('rechecks signing readiness after the asynchronous signer returns', async () => {
    const auth = { ...common(), recipient };
    fixture.assertReady.mockImplementationOnce(() => ({ address: privateKeyToAccount(fixture.key).address, generation: 1 }))
      .mockImplementationOnce(() => ({ address: privateKeyToAccount(fixture.key).address, generation: 1 }))
      .mockImplementationOnce(() => { throw new Error('Router signing is unavailable until startup verification completes.'); });

    await expect(signSendAuth(auth)).rejects.toThrow('startup verification');
  });

  it('does not return a signature across a stop and reinitialization epoch', async () => {
    const auth = { ...common(), recipient };
    fixture.assertReady.mockImplementationOnce(() => ({ address: privateKeyToAccount(fixture.key).address, generation: 7 }))
      .mockImplementationOnce(() => ({ address: privateKeyToAccount(fixture.key).address, generation: 7 }))
      .mockImplementationOnce(() => ({ address: privateKeyToAccount(fixture.key).address, generation: 9 }));

    await expect(signSendAuth(auth)).rejects.toThrow('readiness changed');
  });
});
