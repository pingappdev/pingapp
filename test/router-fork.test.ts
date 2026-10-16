import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, parseAbi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const fixture = await vi.hoisted(async () => {
  const { generatePrivateKey } = await import('viem/accounts');
  const key = generatePrivateKey();
  const relayerKey = generatePrivateKey();
  process.env.ROUTER_SIGNER_KEY = key.slice(2);
  process.env.RELAYER_PRIVATE_KEY = relayerKey.slice(2);
  const config = {
    NODE_ENV: 'test', LOG_LEVEL: 'silent', IP_HASH_SALT: 'router-fork-test',
    CHAIN: 'robinhood', ALCHEMY_API_KEYS: [],
    PUBLIC_RPC_URL: process.env.ANVIL_RPC_URL || 'http://127.0.0.1:8545',
    ROUTER_ENABLED: true,
    ROUTER_ADDRESS: '0x0000000000000000000000000000000000000010',
    ROUTER_NEW_AUTHORIZATIONS_ENABLED: true,
    ROUTER_NEW_CLAIM_SIGNATURES_ENABLED: true,
    ROUTER_RELAY_BROADCASTS_ENABLED: true,
    ROUTER_AUTH_TTL_SECONDS: 600,
    ROUTER_STARTUP_RPC_TIMEOUT_MS: 1500,
  };
  return { key, relayerKey, config };
});
vi.mock('../src/config.js', () => ({ config: fixture.config }));
import { viemChain, NATIVE_TOKEN } from '../src/lib/chain.js';
import { pingRouterAbi } from '../src/lib/pingRouterAbi.js';

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
    let stopRouterSigning = () => {};
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
    fixture.config.ROUTER_ADDRESS = address;
    expect(viemChain.rpcUrls.default.http[0]).toBe(url);
    expect(await client.getCode({ address })).not.toBe('0x');
    const { routerStartupClient } = await import('../src/lib/viem.js');
    expect(await routerStartupClient.getChainId()).toBe(4663);
    expect(await routerStartupClient.getCode({ address })).not.toBe('0x');
    expect(await routerStartupClient.readContract({ address, abi: pingRouterAbi, functionName: 'escrowFee' })).toBe(fee);
    const { initializeRouter, stopRouterSigning: stop } = await import('../src/lib/routerStartup.js');
    stopRouterSigning = stop;
    const { newRouterId: routerId, pingRouterAbi: routerAbi, signClaimAuth, signEscrowAuth, signSendAuth } = await import('../src/lib/router.js');
    await initializeRouter();
    const now = (await client.getBlock()).timestamp;
    const authDeadline = () => BigInt(Math.floor(Date.now() / 1000) + 540);
    const send = { id: routerId(), sender: sender.address, recipient: recipient.address, token: NATIVE_TOKEN, amount, deadline: authDeadline() };
    const sent = await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi: routerAbi, functionName: 'send',
      args: [send, await signSendAuth(send)], value: amount }) });
    expect(sent.status).toBe('success'); expect(await client.getBalance({ address: recipient.address })).toBe(amount);
    const escrow = { id: routerId(), sender: sender.address, token: NATIVE_TOKEN, amount, claimTip: tip, expiresAt: now + 1209600n, deadline: authDeadline() };
    expect((await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi: routerAbi, functionName: 'escrow',
      args: [escrow, await signEscrowAuth(escrow)], value: amount + tip + fee }) })).status).toBe('success');
    const claim = { id: escrow.id, recipient: recipient.address, relayer: relayer.address, deadline: authDeadline() };
    const relayBefore = await client.getBalance({ address: relayer.address });
    const claimed = await client.waitForTransactionReceipt({ hash: await relay.writeContract({ address, abi: routerAbi, functionName: 'claim',
      args: [claim, await signClaimAuth(claim)] }) });
    expect(claimed.status).toBe('success'); expect(await client.getBalance({ address: recipient.address })).toBe(2n * amount);
    expect(await client.getBalance({ address: relayer.address })).toBe(relayBefore + tip - claimed.gasUsed * claimed.effectiveGasPrice);
    expect(await client.getBalance({ address })).toBe(fee);
    const refundEscrow = { ...escrow, id: routerId(), deadline: authDeadline() };
    await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi: routerAbi, functionName: 'escrow',
      args: [refundEscrow, await signEscrowAuth(refundEscrow)], value: amount + tip + fee }) });
    // A sender wallet that rejects ETH: the refund is credited, then withdrawn elsewhere.
    const rejectorAbi = parseAbi(['function execute(address target, bytes payload) payable returns (bytes)']);
    const rejectorArtifact = JSON.parse(fs.readFileSync('contracts/out/RevertingRecipient.sol/RevertingRecipient.json', 'utf8')) as { bytecode: { object: Hex } };
    const rejector = (await client.waitForTransactionReceipt({ hash: await wallet.deployContract({
      abi: rejectorAbi, bytecode: rejectorArtifact.bytecode.object }) })).contractAddress!;
    const later = (await client.getBlock()).timestamp;
    const credited = { id: routerId(), sender: rejector, token: NATIVE_TOKEN, amount, claimTip: tip, expiresAt: later + 1209600n, deadline: authDeadline() };
    await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: rejector, abi: rejectorAbi, functionName: 'execute',
      args: [address, encodeFunctionData({ abi: routerAbi, functionName: 'escrow', args: [credited, await signEscrowAuth(credited)] })],
      value: amount + tip + fee }) });
    const senderBefore = await client.getBalance({ address: sender.address });
    await anvil.setNextBlockTimestamp({ timestamp: credited.expiresAt });
    await anvil.mine({ blocks: 1 });
    const refunded = await client.waitForTransactionReceipt({ hash: await relay.writeContract({ address, abi: pingRouterAbi,
      functionName: 'refund', args: [refundEscrow.id] }) });
    expect(refunded.status).toBe('success');
    expect(await client.getBalance({ address: sender.address })).toBe(senderBefore + amount + tip);
    expect((await client.waitForTransactionReceipt({ hash: await relay.writeContract({ address, abi: pingRouterAbi,
      functionName: 'refund', args: [credited.id] }) })).status).toBe('success');
    expect(await client.readContract({ address, abi: pingRouterAbi, functionName: 'owedEth', args: [rejector] })).toBe(amount + tip);
    expect(await client.readContract({ address, abi: pingRouterAbi, functionName: 'totalOwed' })).toBe(amount + tip);
    const recipientBefore = await client.getBalance({ address: recipient.address });
    await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: rejector, abi: rejectorAbi, functionName: 'execute',
      args: [address, encodeFunctionData({ abi: pingRouterAbi, functionName: 'withdrawOwed', args: [recipient.address] })] }) });
    expect(await client.getBalance({ address: recipient.address })).toBe(recipientBefore + amount + tip);
    expect(await client.readContract({ address, abi: pingRouterAbi, functionName: 'totalOwed' })).toBe(0n);
    expect(await client.getBalance({ address })).toBe(3n * fee);
    } finally {
      stopRouterSigning();
      await anvil.revert({ id: snapshot });
    }
  }, 120_000);
});
