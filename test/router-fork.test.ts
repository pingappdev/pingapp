import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, http, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const fixture = await vi.hoisted(async () => {
  const { generatePrivateKey } = await import('viem/accounts');
  return { key: generatePrivateKey() };
});
vi.mock('../src/config.js', async (original) => {
  const { config } = await original<typeof import('../src/config.js')>();
  return { config: { ...config, ROUTER_SIGNER_KEY: fixture.key.slice(2) } };
});
import { viemChain, NATIVE_TOKEN } from '../src/lib/chain.js';
import { newRouterId, pingRouterAbi, routerDomain, signClaimAuth, signEscrowAuth, signSendAuth } from '../src/lib/router.js';

describe.skipIf(!process.env.ANVIL_RPC_URL)('backend signatures against local Anvil', () => {
  it('deploys locally and executes signed send, escrow, claim and refund', async () => {
    const url = process.env.ANVIL_RPC_URL!;
    if (!['anvil', 'localhost', '127.0.0.1', 'host.docker.internal'].includes(new URL(url).hostname)) {
      throw new Error('Router integration tests require a local Anvil URL.');
    }
    const transport = http(url, { retryCount: 0 });
    const client = createPublicClient({ chain: viemChain, transport });
    const anvil = createTestClient({ chain: viemChain, mode: 'anvil', transport });
    expect(await client.getChainId()).toBe(4663);
    const snapshot = await anvil.snapshot();
    try {
    const sender = privateKeyToAccount(generatePrivateKey());
    const recipient = privateKeyToAccount(generatePrivateKey());
    const relayer = privateKeyToAccount(generatePrivateKey());
    // These RPC methods also prevent accidentally running against a normal node.
    await anvil.setBalance({ address: sender.address, value: 1000000000000000000n });
    await anvil.setBalance({ address: relayer.address, value: 100000000000000000n });
    const wallet = createWalletClient({ account: sender, chain: viemChain, transport });
    const relay = createWalletClient({ account: relayer, chain: viemChain, transport });
    const artifact = JSON.parse(fs.readFileSync('contracts/out/PingRouter.sol/PingRouter.json', 'utf8')) as { bytecode: { object: Hex } };
    const fee = 50000000000000n; const tip = 20000000000000n; const amount = 10000000000000000n;
    const deployed = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({
      abi: pingRouterAbi, bytecode: artifact.bytecode.object, args: [privateKeyToAccount(fixture.key).address, sender.address, fee],
    }) });
    const address = deployed.contractAddress!;
    const domain = { ...routerDomain, chainId: 4663, verifyingContract: address };
    const now = (await client.getBlock()).timestamp;
    const send = { id: newRouterId(), sender: sender.address, recipient: recipient.address, token: NATIVE_TOKEN, amount, deadline: now + 600n };
    const sent = await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi: pingRouterAbi, functionName: 'send',
      args: [send, await signSendAuth(send, domain)], value: amount }) });
    expect(sent.status).toBe('success'); expect(await client.getBalance({ address: recipient.address })).toBe(amount);
    const escrow = { id: newRouterId(), sender: sender.address, token: NATIVE_TOKEN, amount, claimTip: tip, expiresAt: now + 1209600n, deadline: now + 600n };
    expect((await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi: pingRouterAbi, functionName: 'escrow',
      args: [escrow, await signEscrowAuth(escrow, domain)], value: amount + tip + fee }) })).status).toBe('success');
    const claim = { id: escrow.id, recipient: recipient.address, relayer: relayer.address, deadline: now + 600n };
    const relayBefore = await client.getBalance({ address: relayer.address });
    const claimed = await client.waitForTransactionReceipt({ hash: await relay.writeContract({ address, abi: pingRouterAbi, functionName: 'claim',
      args: [claim, await signClaimAuth(claim, domain)] }) });
    expect(claimed.status).toBe('success'); expect(await client.getBalance({ address: recipient.address })).toBe(2n * amount);
    expect(await client.getBalance({ address: relayer.address })).toBe(relayBefore + tip - claimed.gasUsed * claimed.effectiveGasPrice);
    expect(await client.getBalance({ address })).toBe(fee);
    const refundEscrow = { ...escrow, id: newRouterId() };
    await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi: pingRouterAbi, functionName: 'escrow',
      args: [refundEscrow, await signEscrowAuth(refundEscrow, domain)], value: amount + tip + fee }) });
    const senderBefore = await client.getBalance({ address: sender.address });
    await anvil.setNextBlockTimestamp({ timestamp: escrow.expiresAt });
    await anvil.mine({ blocks: 1 });
    const refunded = await client.waitForTransactionReceipt({ hash: await relay.writeContract({ address, abi: pingRouterAbi,
      functionName: 'refund', args: [refundEscrow.id] }) });
    expect(refunded.status).toBe('success');
    expect(await client.getBalance({ address: sender.address })).toBe(senderBefore + amount + tip);
    expect(await client.getBalance({ address })).toBe(2n * fee);
    } finally {
      await anvil.revert({ id: snapshot });
    }
  }, 120_000);
});
