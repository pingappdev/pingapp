import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  getContractAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const resourcePrefix = process.env.PINGAPP_INDEXER_TEST_RESOURCE_PREFIX ?? "";
const enabled = /^pingapp-audit-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(resourcePrefix);
const expectedDatabase = resourcePrefix.replaceAll("-", "_");
const suite = enabled ? describe : describe.skip;
const escrowIds: string[] = [];
const phoneHashes: string[] = [];
type ProbeChild = ChildProcessByStdio<null, Readable, Readable>;
const children: ProbeChild[] = [];
const capturedChildOutput = new WeakMap<ProbeChild, string>();
let db: any;
let sql: any;
let redis: any;
let schema: any;
let config: any;
let startup: any;
let router: any;
let viemChain: any;
let publicClient: any;
let anvil: any;
let senderAccount: ReturnType<typeof privateKeyToAccount>;
let deployerAccount: ReturnType<typeof privateKeyToAccount>;
let feeRecipientAccount: ReturnType<typeof privateKeyToAccount>;
let signerAccount: ReturnType<typeof privateKeyToAccount>;
let signerKey: Hex;
let relayerKey: Hex;
let feeWei = 0n;
let tokenAddress = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
let deploymentBlock = 0n;
let anvilRpcUrl = "";

type EscrowFixture = {
  id: Hex;
  code: string;
  phoneHash: string;
  senderAddress: Address;
  txHash: Hex;
  blockNumber: bigint;
};

function loopbackUrl(value: string | undefined, expectedPort: string | undefined, label: string): URL {
  if (!value || !expectedPort) throw new Error(`Indexer recovery requires an explicit local ${label} port.`);
  const url = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== expectedPort) {
    throw new Error(`Indexer recovery refuses a non-loopback ${label} endpoint.`);
  }
  return url;
}

async function reserveTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve an API test port.");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function probeEnv(mode: string, escrowId: string, provider = "accept"): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ROUTER_ENABLED: "true",
    ROUTER_ADDRESS: config.ROUTER_ADDRESS,
    ROUTER_DEPLOY_BLOCK: String(deploymentBlock),
    ROUTER_NEW_AUTHORIZATIONS_ENABLED: "false",
    ROUTER_NEW_CLAIM_SIGNATURES_ENABLED: "false",
    ROUTER_RELAY_BROADCASTS_ENABLED: "false",
    ROUTER_SIGNER_KEY: "",
    RELAYER_PRIVATE_KEY: "",
    SMS_DRIVER: "seven",
    SMS_ENABLED: "true",
    SEVEN_API_KEY: "fake-indexer-gateway-key",
    PUBLIC_RPC_URL: anvilRpcUrl,
    ANVIL_RPC_URL: anvilRpcUrl,
    ALCHEMY_API_KEYS: "",
    PINGAPP_INDEXER_PROBE_MODE: mode,
    PINGAPP_INDEXER_PROBE_PROVIDER: provider,
    PINGAPP_INDEXER_PROBE_ESCROW_ID: escrowId,
  };
}

function launch(command: string, args: string[], env: NodeJS.ProcessEnv): ProbeChild {
  const child = spawn(command, args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  capturedChildOutput.set(child, "");
  const collect = (chunk: Buffer) => capturedChildOutput.set(child, `${capturedChildOutput.get(child) ?? ""}${chunk.toString()}`);
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  children.push(child);
  return child;
}

function safeChildDiagnostic(child: ProbeChild): string {
  return (capturedChildOutput.get(child) ?? "").slice(-1_500)
    .replace(/\b0x[0-9a-f]{64}\b/gi, "[TX_HASH]")
    .replace(/\+\d{10,}/g, "[PHONE]")
    .replace(/(\b(?:key|secret|token|password)\b\s*[:=]\s*)[^\s,]+/gi, "$1[REDACTED]");
}

async function childOutput(child: ProbeChild, timeoutMs = 30_000): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Indexer helper exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  return { ...result, output };
}

async function waitForExit(child: ProbeChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function waitForMarker(child: ProbeChild, marker: string, timeoutMs = 30_000): Promise<string> {
  let output = capturedChildOutput.get(child) ?? "";
  if (output.includes(marker)) return output;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out waiting for ${marker}. Output: ${output.slice(-2000)}`));
    }, timeoutMs);
    const inspect = () => {
      output = capturedChildOutput.get(child) ?? output;
      if (output.includes(marker)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Indexer helper exited before ${marker} (code ${code}, signal ${signal}). Output: ${output.slice(-2000)}`));
    });
  });
}

async function stopChild(child: ProbeChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(8_000).then(() => { if (child.exitCode === null) child.kill("SIGKILL"); }),
  ]);
}

async function waitFor<T>(description: string, read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (ready(last)) return last;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function createAuthorizedDeposit(options: { deliveryMode: "claim" | "automatic"; withReceiptHash?: boolean }): Promise<EscrowFixture> {
  const id = `0x${randomBytes(32).toString("hex")}` as Hex;
  const code = randomBytes(8).toString("hex").slice(0, 10);
  const phone = `+1202555${String(101 + escrowIds.length).padStart(4, "0")}`;
  const amount = 10_000_000_000_000_000n;
  const claimTip = 20_000_000_000_000n;
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60);
  const authDeadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const expiresAtDate = new Date(Number(expiresAt) * 1000);
  const phoneHash = (await import("../src/lib/crypto.js")).phoneHmac(phone);
  phoneHashes.push(phoneHash);
  await anvil.setBalance({ address: senderAccount.address, value: 2_000_000_000_000_000_000n });
  await db.insert(schema.escrows).values({
    id,
    code,
    senderAddress: senderAccount.address.toLowerCase(),
    recipientPhoneHmac: phoneHash,
    recipientPhoneEnc: (await import("../src/lib/crypto.js")).encrypt(phone),
    recipientPhoneMasked: "••••0101",
    deliveryMode: options.deliveryMode,
    ...(options.deliveryMode === "automatic" ? { recipientRef: `audit:${id.slice(2, 14)}` } : {}),
    tokenAddress,
    amountRaw: amount.toString(),
    claimTipWei: claimTip.toString(),
    feeWei: feeWei.toString(),
    expiresAt: expiresAtDate,
    authDeadline: new Date(Number(authDeadline) * 1000),
    status: "authorized",
    smsStatus: options.deliveryMode === "claim" ? "failed" : "not_required",
    smsAttemptCount: 0,
    smsNextAttemptAt: null,
  });
  escrowIds.push(id);

  const authorization = { id, sender: senderAccount.address, token: tokenAddress as Address, amount, claimTip, expiresAt, deadline: authDeadline };
  const signature = await router.signEscrowAuth(authorization);
  const hash = await createWalletClient({ account: senderAccount, chain: viemChain, transport: http(anvilRpcUrl, { retryCount: 0 }) })
    .writeContract({ address: config.ROUTER_ADDRESS as Address, abi: router.pingRouterAbi, functionName: "escrow",
      args: [authorization, signature], value: amount + claimTip + feeWei, chain: viemChain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  if (options.withReceiptHash) {
    await db.update(schema.escrows).set({ depositTxHash: hash.toLowerCase() }).where((await import("drizzle-orm")).eq(schema.escrows.id, id));
  }
  return { id, code, phoneHash, senderAddress: senderAccount.address, txHash: hash, blockNumber: receipt.blockNumber };
}

suite("full local indexer and keyless worker recovery (disposable services)", () => {
  beforeAll(async () => {
    const prefix = process.env.PINGAPP_INDEXER_TEST_RESOURCE_PREFIX;
    if (!prefix || !/^pingapp-audit-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(prefix)) {
      throw new Error("Indexer recovery requires an explicitly isolated CI resource prefix.");
    }
    const databaseUrl = loopbackUrl(process.env.DATABASE_URL, process.env.PINGAPP_INDEXER_TEST_POSTGRES_PORT, "PostgreSQL");
    const redisUrl = loopbackUrl(process.env.REDIS_URL, process.env.PINGAPP_INDEXER_TEST_REDIS_PORT, "Redis");
    const anvilUrl = loopbackUrl(process.env.ANVIL_RPC_URL, process.env.PINGAPP_INDEXER_TEST_ANVIL_PORT, "Anvil");
    if (databaseUrl.pathname !== `/${expectedDatabase}` || anvilUrl.origin !== process.env.PUBLIC_RPC_URL ||
        process.env.PUBLIC_RPC_URL !== process.env.ANVIL_RPC_URL || process.env.ALCHEMY_API_KEYS) {
      throw new Error("Indexer recovery only permits its named local database and its local Anvil RPC, with no provider fallback.");
    }
    anvilRpcUrl = anvilUrl.origin;

    const chain = defineChain({
      id: 4663,
      name: "Disposable PingApp Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [anvilRpcUrl] } },
    });
    const transport = http(anvilRpcUrl, { retryCount: 0 });
    const bootstrapClient = createPublicClient({ chain, transport });
    const bootstrapAnvil = createTestClient({ chain, mode: "anvil", transport });
    if (await bootstrapClient.getChainId() !== 4663 || await bootstrapClient.getBlockNumber() !== 0n) {
      throw new Error("Indexer recovery requires a fresh, local Anvil chain at block zero.");
    }

    deployerAccount = privateKeyToAccount(generatePrivateKey());
    senderAccount = privateKeyToAccount(generatePrivateKey());
    signerKey = generatePrivateKey();
    relayerKey = generatePrivateKey();
    signerAccount = privateKeyToAccount(signerKey);
    feeRecipientAccount = privateKeyToAccount(generatePrivateKey());
    await bootstrapAnvil.setBalance({ address: deployerAccount.address, value: 10n ** 20n });
    await bootstrapAnvil.setBalance({ address: senderAccount.address, value: 10n ** 20n });
    const predictedRouter = getContractAddress({ from: deployerAccount.address, nonce: 0n });
    feeWei = 50_000_000_000_000n;

    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      CHAIN: "robinhood",
      PUBLIC_RPC_URL: anvilRpcUrl,
      ANVIL_RPC_URL: anvilRpcUrl,
      ALCHEMY_API_KEYS: "",
      ROUTER_ENABLED: "true",
      ROUTER_ADDRESS: predictedRouter,
      ROUTER_DEPLOY_BLOCK: "1",
      ROUTER_STARTUP_RPC_TIMEOUT_MS: "1500",
      ROUTER_NEW_AUTHORIZATIONS_ENABLED: "true",
      ROUTER_NEW_CLAIM_SIGNATURES_ENABLED: "true",
      ROUTER_RELAY_BROADCASTS_ENABLED: "true",
      ROUTER_AUTH_TTL_SECONDS: "600",
      ROUTER_SIGNER_KEY: signerKey.slice(2),
      RELAYER_PRIVATE_KEY: relayerKey.slice(2),
      SMS_DRIVER: "seven",
      SMS_ENABLED: "true",
      SEVEN_API_KEY: "fake-indexer-gateway-key",
      SMS_DAILY_CAP: "12",
      SMS_FUNDED_INVITE_DAILY_BUDGET: "4",
      SMS_CLAIM_OTP_DAILY_BUDGET: "4",
      SMS_ONBOARDING_DAILY_BUDGET: "3",
      SMS_ADMIN_DAILY_BUDGET: "1",
    });

    const [configModule, dbClient, redisClient, schemaModule, startupModule, routerModule, chainModule] = await Promise.all([
      import("../src/config.js"), import("../src/db/client.js"), import("../src/lib/redis.js"),
      import("../src/db/schema.js"), import("../src/lib/routerStartup.js"), import("../src/lib/router.js"),
      import("../src/lib/chain.js"),
    ]);
    config = configModule.config;
    db = dbClient.db;
    sql = dbClient.sql;
    redis = redisClient.redis;
    schema = schemaModule;
    startup = startupModule;
    router = routerModule;
    viemChain = chainModule.viemChain;
    if (config.PUBLIC_RPC_URL !== anvilRpcUrl || config.ALCHEMY_API_KEYS.length !== 0 || config.ROUTER_ADDRESS.toLowerCase() !== predictedRouter.toLowerCase()) {
      throw new Error("Indexer recovery refused unexpected or fallback RPC configuration.");
    }
    if (await sql`select current_database() as name`.then((rows: Array<{ name: string }>) => rows[0]?.name) !== expectedDatabase) {
      throw new Error("Indexer recovery database name does not match its isolated resource prefix.");
    }

    await bootstrapAnvil.setBalance({ address: feeRecipientAccount.address, value: 0n });
    const artifact = JSON.parse(readFileSync("contracts/out/PingRouter.sol/PingRouter.json", "utf8")) as { bytecode: { object: Hex } };
    const deployWallet = createWalletClient({ account: deployerAccount, chain, transport });
    const deploymentReceipt = await bootstrapClient.waitForTransactionReceipt({
      hash: await deployWallet.deployContract({
        abi: router.pingRouterAbi,
        bytecode: artifact.bytecode.object,
        args: [signerAccount.address, feeRecipientAccount.address, feeWei],
      }),
    });
    expect(deploymentReceipt.status).toBe("success");
    expect(deploymentReceipt.contractAddress?.toLowerCase()).toBe(predictedRouter.toLowerCase());
    deploymentBlock = deploymentReceipt.blockNumber;

    publicClient = createPublicClient({ chain: viemChain, transport });
    anvil = bootstrapAnvil;
    await startup.initializeRouter();
    expect(startup.assertRouterSigningReady().address.toLowerCase()).toBe(signerAccount.address.toLowerCase());

    await db.insert(schema.tokens).values({
      address: tokenAddress,
      chainId: 4663,
      symbol: "ETH",
      name: "Native ETH",
      decimals: 18,
      kind: "native",
    });
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    await redis.del("sms:disabled", `sms:count:${day}`, `sms:count:${day}:funded_invite`,
      `sms:count:${day}:claim_otp`, `sms:count:${day}:onboarding`, `sms:count:${day}:admin_test`, `sms:warned:${day}`);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(children.map(stopChild));
    if (db && escrowIds.length) await db.delete(schema.escrows)
      .where((await import("drizzle-orm")).inArray(schema.escrows.id, escrowIds)).catch(() => undefined);
    if (db && phoneHashes.length) await db.delete(schema.smsLog)
      .where((await import("drizzle-orm")).inArray(schema.smsLog.phoneHmac, phoneHashes)).catch(() => undefined);
    if (db && schema) await db.delete(schema.kv).where((await import("drizzle-orm")).inArray(schema.kv.key, ["router:scope", "router:lastBlock"])).catch(() => undefined);
    if (db && tokenAddress) await db.delete(schema.tokens).where((await import("drizzle-orm")).eq(schema.tokens.address, tokenAddress)).catch(() => undefined);
    if (redis) {
      const reservations = await redis.keys("sms:reservation:*").catch(() => [] as string[]);
      const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      await redis.del("sms:disabled", `sms:count:${day}`, `sms:count:${day}:funded_invite`,
        `sms:count:${day}:claim_otp`, `sms:count:${day}:onboarding`, `sms:count:${day}:admin_test`,
        `sms:warned:${day}`, ...reservations).catch(() => undefined);
      await redis.quit().catch(() => undefined);
    }
    await sql?.end({ timeout: 5 }).catch(() => undefined);
  }, 30_000);

  it("recovers one funded invite through the indexer after a durable crash and suppresses uncertain duplicates", async () => {
    const accepted = await createAuthorizedDeposit({ deliveryMode: "claim" });
    const [beforeIndex] = await db.select().from(schema.escrows)
      .where((await import("drizzle-orm")).eq(schema.escrows.id, accepted.id));
    expect(beforeIndex).toMatchObject({ status: "authorized", smsStatus: "failed", smsAttemptCount: 0 });
    const checkpoint = launch(process.execPath, ["--import", "tsx", "test/helpers/indexer-recovery-probe.ts"],
      probeEnv("checkpoint-crash", accepted.id, "none"));
    const checkpointOutput = await waitForMarker(checkpoint, "INDEXER_CHECKPOINT_COMMITTED");
    expect(checkpointOutput).not.toContain("FAKE_SMS_PROVIDER_CALL=");
    checkpoint.kill("SIGKILL");
    await waitForExit(checkpoint);

    let [indexed] = await db.select().from(schema.escrows).where((await import("drizzle-orm")).eq(schema.escrows.id, accepted.id));
    expect(indexed).toMatchObject({ status: "deposited", smsStatus: "deferred_budget", smsAttemptCount: 0, depositTxHash: accepted.txHash.toLowerCase() });
    expect(indexed.smsNextAttemptAt).toBeInstanceOf(Date);
    const receipt = await publicClient.getTransactionReceipt({ hash: accepted.txHash });
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    expect(indexed.depositedAt.toISOString()).toBe(new Date(Number(block.timestamp) * 1000).toISOString());
    await expect((await import("../src/db/kv.js")).kvGet("router:lastBlock")).resolves.toBeGreaterThan(receipt.blockNumber);

    const recovered = launch(process.execPath, ["--import", "tsx", "test/helpers/indexer-recovery-probe.ts"],
      probeEnv("resume", accepted.id, "accept"));
    const recovery = await childOutput(recovered);
    expect(recovery.code).toBe(0);
    expect(recovery.output.match(/FAKE_SMS_PROVIDER_CALL=/g)).toHaveLength(1);
    expect(recovery.output).toContain("INDEXER_COMPLETED;FAKE_SMS_CALLS=1");
    [indexed] = await db.select().from(schema.escrows).where((await import("drizzle-orm")).eq(schema.escrows.id, accepted.id));
    expect(indexed).toMatchObject({ status: "deposited", smsStatus: "sent", smsAttemptCount: 1, smsNextAttemptAt: null });

    const noDuplicate = launch(process.execPath, ["--import", "tsx", "test/helpers/indexer-recovery-probe.ts"],
      probeEnv("resume", accepted.id, "accept"));
    const duplicateCheck = await childOutput(noDuplicate);
    expect(duplicateCheck.code).toBe(0);
    expect(duplicateCheck.output).toContain("INDEXER_COMPLETED;FAKE_SMS_CALLS=0");
    expect(duplicateCheck.output).not.toContain("FAKE_SMS_PROVIDER_CALL=");

    const uncertain = await createAuthorizedDeposit({ deliveryMode: "claim" });
    const unknownWindow = launch(process.execPath, ["--import", "tsx", "test/helpers/indexer-recovery-probe.ts"],
      probeEnv("unknown-window", uncertain.id, "hang"));
    const providerStarted = await waitForMarker(unknownWindow, "FAKE_SMS_PROVIDER_CALL=1");
    expect(providerStarted).toContain("KEYLESS_ROUTER_READS_OK");
    unknownWindow.kill("SIGKILL");
    await waitForExit(unknownWindow);
    let [unknownRow] = await db.select().from(schema.escrows).where((await import("drizzle-orm")).eq(schema.escrows.id, uncertain.id));
    expect(unknownRow).toMatchObject({ status: "deposited", smsStatus: "provider_unknown", smsAttemptCount: 0, smsNextAttemptAt: null,
      depositTxHash: uncertain.txHash.toLowerCase() });

    const unknownRecovery = launch(process.execPath, ["--import", "tsx", "test/helpers/indexer-recovery-probe.ts"],
      probeEnv("resume", uncertain.id, "accept"));
    const unknownCheck = await childOutput(unknownRecovery);
    expect(unknownCheck.code).toBe(0);
    expect(unknownCheck.output).toContain("INDEXER_COMPLETED;FAKE_SMS_CALLS=0");
    expect(unknownCheck.output).not.toContain("FAKE_SMS_PROVIDER_CALL=");
    [unknownRow] = await db.select().from(schema.escrows).where((await import("drizzle-orm")).eq(schema.escrows.id, uncertain.id));
    expect(unknownRow.smsStatus).toBe("provider_unknown");
  }, 120_000);

  it("boots the API and worker keyless, then confirms receipts and indexes deposits without signing", async () => {
    const confirmed = await createAuthorizedDeposit({ deliveryMode: "automatic", withReceiptHash: true });
    const indexed = await createAuthorizedDeposit({ deliveryMode: "automatic" });
    const apiPort = await reserveTcpPort();
    const keylessEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      PORT: String(apiPort),
      ROUTER_ENABLED: "true",
      ROUTER_ADDRESS: config.ROUTER_ADDRESS,
      ROUTER_DEPLOY_BLOCK: String(deploymentBlock),
      ROUTER_NEW_AUTHORIZATIONS_ENABLED: "false",
      ROUTER_NEW_CLAIM_SIGNATURES_ENABLED: "false",
      ROUTER_RELAY_BROADCASTS_ENABLED: "false",
      ROUTER_SIGNER_KEY: "",
      RELAYER_PRIVATE_KEY: "",
      SMS_ENABLED: "false",
      PUBLIC_RPC_URL: anvilRpcUrl,
      ANVIL_RPC_URL: anvilRpcUrl,
      ALCHEMY_API_KEYS: "",
    };
    const guardedArgs = ["--import", "tsx", "--import", "./test/helpers/local-fetch-guard.mjs"];
    const api = launch(process.execPath, [...guardedArgs, "src/server.ts"], keylessEnv);
    const healthUrl = `http://127.0.0.1:${apiPort}/health`;
    const health = await waitFor("keyless API health", async () => {
      const response = await fetch(healthUrl).catch(() => null);
      if (!response) return null;
      return { status: response.status, body: await response.json() };
    }, (value) => value?.status === 200, 30_000).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "API health wait failed.";
      throw new Error(`${message} Child output: ${safeChildDiagnostic(api)}`);
    });
    expect(health?.body).toMatchObject({ ok: true, db: true, redis: true });
    const configResponse = await fetch(`http://127.0.0.1:${apiPort}/v1/config`);
    expect(configResponse.status).toBe(200);
    expect(await configResponse.json()).toMatchObject({ features: { escrow: true }, router: { enabled: true } });

    const worker = launch(process.execPath, [...guardedArgs, "src/worker.ts"], keylessEnv);
    await waitForMarker(worker, "worker started", 30_000);
    const bootIssuer = await waitForMarker(worker, "LOCAL_FAKE_PROVIDER=robinhood-assets", 30_000);
    expect(bootIssuer).not.toContain("BLOCKED_EXTERNAL_FETCH");

    const { enqueue, closeQueues } = await import("../src/lib/queue.js");
    await enqueue("escrows", "confirm", { escrowId: confirmed.id, attempt: 0 }, { jobId: `verify-confirm-${randomUUID()}` });
    await enqueue("escrows", "index", {}, { jobId: `verify-index-${randomUUID()}` });

    const confirmedRow = await waitFor("keyless worker receipt confirmation", async () => {
      const [row] = await db.select().from(schema.escrows).where((await import("drizzle-orm")).eq(schema.escrows.id, confirmed.id));
      return row;
    }, (row) => row?.status === "deposited", 30_000);
    const indexedRow = await waitFor("keyless worker log indexing", async () => {
      const [row] = await db.select().from(schema.escrows).where((await import("drizzle-orm")).eq(schema.escrows.id, indexed.id));
      return row;
    }, (row) => row?.status === "deposited", 30_000);
    expect(confirmedRow.depositTxHash).toBe(confirmed.txHash.toLowerCase());
    expect(indexedRow.depositTxHash).toBe(indexed.txHash.toLowerCase());
    expect(confirmedRow.claimTxHash).toBeNull();
    expect(indexedRow.claimTxHash).toBeNull();
    const claimAuthorizations = await db.select({ escrowId: schema.claimAuthorizations.escrowId })
      .from(schema.claimAuthorizations).where((await import("drizzle-orm")).inArray(schema.claimAuthorizations.escrowId, [confirmed.id, indexed.id]));
    expect(claimAuthorizations).toEqual([]);
    const claimJobs = await db.select({ key: schema.kv.key }).from(schema.kv)
      .where((await import("drizzle-orm")).inArray(schema.kv.key, [`router:claim:${confirmed.id}`, `router:claim:${indexed.id}`]));
    expect(claimJobs).toEqual([]);

    const deniedWrites = launch(process.execPath, ["--import", "tsx", "test/helpers/indexer-recovery-probe.ts"],
      probeEnv("keyless-denial", confirmed.id));
    const deniedOutput = await childOutput(deniedWrites);
    expect(deniedOutput.code).toBe(0);
    expect(deniedOutput.output).toContain("KEYLESS_ESCROW_SIGNING_REJECTED");
    expect(deniedOutput.output).toContain("KEYLESS_CLAIM_SIGNING_REJECTED");
    expect(deniedOutput.output).toContain("KEYLESS_RELAY_BROADCAST_REJECTED");

    await stopChild(worker);
    await stopChild(api);
    await closeQueues();
    expect(capturedChildOutput.get(api)).not.toContain("BLOCKED_EXTERNAL_FETCH");
    expect(capturedChildOutput.get(worker)).not.toContain("BLOCKED_EXTERNAL_FETCH");
  }, 120_000);
});
