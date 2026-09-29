import { describe, expect, it, vi } from 'vitest';
import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { LOGIN_STATEMENT, verifySiwe, type SiweDependencies } from '../src/modules/auth/service.js';

const account = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
const now = new Date('2026-09-29T12:00:00.000Z');
const origin = 'http://localhost:7400';
const domain = 'localhost:7400';
const nonce = 'abcdefghijklmnopqrstuvwxyz';

function dependencies(consumeNonce = vi.fn(async () => 1)): SiweDependencies {
  return {
    consumeNonce,
    verifySignature: (message, signature) => verifyMessage({
      address: account.address,
      message,
      signature,
    }),
    allowedDomains: [domain],
    allowedOrigins: [origin],
    chainId: 46630,
    now: () => now,
  };
}

async function signedMessage(overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}) {
  const message = createSiweMessage({
    domain,
    address: account.address,
    uri: origin,
    version: '1',
    chainId: 46630,
    nonce,
    issuedAt: now,
    statement: LOGIN_STATEMENT,
    ...overrides,
  });
  return { message, signature: await account.signMessage({ message }) };
}

describe('SIWE verification', () => {
  it('accepts a valid, locally signed message', async () => {
    const { message, signature } = await signedMessage();
    await expect(verifySiwe(message, signature, { expectedStatement: LOGIN_STATEMENT }, dependencies()))
      .resolves.toBe(account.address);
  });

  it('rejects a domain outside the allowed hosts', async () => {
    const { message, signature } = await signedMessage({ domain: 'evil.example' });
    await expect(verifySiwe(message, signature, {}, dependencies())).rejects.toMatchObject({ code: 'SIWE_INVALID' });
  });

  it('rejects a wrong chain', async () => {
    const { message, signature } = await signedMessage({ chainId: 1 });
    await expect(verifySiwe(message, signature, {}, dependencies())).rejects.toMatchObject({ code: 'SIWE_INVALID' });
  });

  it('rejects a nonce already consumed by a prior request', async () => {
    const { message, signature } = await signedMessage();
    const consumeNonce = vi.fn(async () => 0);
    await expect(verifySiwe(message, signature, {}, dependencies(consumeNonce)))
      .rejects.toMatchObject({ code: 'SIWE_INVALID' });
    expect(consumeNonce).toHaveBeenCalledOnce();
  });

  it('rejects an issuedAt older than ten minutes', async () => {
    const { message, signature } = await signedMessage({ issuedAt: new Date(now.getTime() - 601_000) });
    await expect(verifySiwe(message, signature, {}, dependencies())).rejects.toMatchObject({ code: 'SIWE_INVALID' });
  });

  it('rejects a URI from an unapproved origin', async () => {
    const { message, signature } = await signedMessage({ uri: 'https://evil.example' });
    await expect(verifySiwe(message, signature, {}, dependencies())).rejects.toMatchObject({ code: 'SIWE_INVALID' });
  });

  it('rejects an otherwise valid signature from a different wallet during reauth', async () => {
    const { message, signature } = await signedMessage();
    await expect(verifySiwe(message, signature, { expectedAddress: '0x0000000000000000000000000000000000000001' }, dependencies()))
      .rejects.toMatchObject({ code: 'SIWE_INVALID' });
  });

  it('rejects an invalid signature after consuming the nonce', async () => {
    const { message } = await signedMessage();
    const wrongAccount = privateKeyToAccount('0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    const signature = await wrongAccount.signMessage({ message });
    const consumeNonce = vi.fn(async () => 1);
    await expect(verifySiwe(message, signature, {}, dependencies(consumeNonce)))
      .rejects.toMatchObject({ code: 'SIWE_INVALID' });
    expect(consumeNonce).toHaveBeenCalledOnce();
  });
});
