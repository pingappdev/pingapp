import { config } from "../../src/config.js";
import { sql } from "../../src/db/client.js";
import { redis } from "../../src/lib/redis.js";
import { initializeRouter } from "../../src/lib/routerStartup.js";
import { indexEscrows } from "../../src/modules/escrows/jobs.js";

const mode = process.env.PINGAPP_INDEXER_PROBE_MODE;
const targetId = process.env.PINGAPP_INDEXER_PROBE_ESCROW_ID;
const prefix = process.env.PINGAPP_INDEXER_TEST_RESOURCE_PREFIX ?? "";
const expectedDatabase = prefix.replaceAll("-", "_");
const databaseUrl = new URL(config.DATABASE_URL);
const redisUrl = new URL(config.REDIS_URL);
const anvilUrl = new URL(config.PUBLIC_RPC_URL);

if (!/^pingapp-audit-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(prefix) || !targetId) {
  throw new Error("Indexer recovery probe requires an explicit disposable resource and escrow ID.");
}
if (
  !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) ||
  databaseUrl.port !== process.env.PINGAPP_INDEXER_TEST_POSTGRES_PORT ||
  databaseUrl.pathname !== `/${expectedDatabase}` ||
  !["127.0.0.1", "localhost"].includes(redisUrl.hostname) ||
  redisUrl.port !== process.env.PINGAPP_INDEXER_TEST_REDIS_PORT ||
  !["127.0.0.1", "localhost"].includes(anvilUrl.hostname) ||
  anvilUrl.origin !== process.env.ANVIL_RPC_URL ||
  config.PUBLIC_RPC_URL !== process.env.ANVIL_RPC_URL ||
  config.ALCHEMY_API_KEYS.length !== 0 ||
  config.ROUTER_ENABLED !== true ||
  config.ROUTER_NEW_AUTHORIZATIONS_ENABLED !== false ||
  config.ROUTER_NEW_CLAIM_SIGNATURES_ENABLED !== false ||
  config.ROUTER_RELAY_BROADCASTS_ENABLED !== false ||
  process.env.ROUTER_SIGNER_KEY !== "" ||
  process.env.RELAYER_PRIVATE_KEY !== ""
) {
  throw new Error("Indexer recovery probe refuses nonlocal RPC, shared services, or signer-enabled configuration.");
}

const nativeFetch = globalThis.fetch.bind(globalThis);
let providerCalls = 0;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const value = input instanceof Request ? input.url : String(input);
  const url = new URL(value);
  if (url.href === "https://gateway.seven.io/api/sms") {
    providerCalls += 1;
    const write = new Promise<void>((resolve) => {
      process.stdout.write(`FAKE_SMS_PROVIDER_CALL=${providerCalls}\n`, "utf8", () => resolve());
    });
    await write;
    if (process.env.PINGAPP_INDEXER_PROBE_PROVIDER === "hang") {
      await new Promise<never>(() => undefined);
    }
    if (process.env.PINGAPP_INDEXER_PROBE_PROVIDER !== "accept") {
      throw new Error("Indexer recovery probe has no fake SMS response configured.");
    }
    return new Response(JSON.stringify({
      success: "100",
      total_price: 0.01,
      messages: [{ id: "fake-indexer-accepted", success: true, error: null, price: 0.01 }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.origin === anvilUrl.origin) return nativeFetch(input, init);
  throw new Error("Indexer recovery probe blocked an unexpected external request.");
};

try {
  await initializeRouter();
  process.stdout.write("KEYLESS_ROUTER_READS_OK\n");
  if (mode === "keyless-denial") {
    const [{ signClaimAuth, signEscrowAuth }, { assertRouterOperationEnabled }] = await Promise.all([
      import("../../src/lib/router.js"), import("../../src/modules/escrows/incident.js"),
    ]);
    const deniedAttempts: Array<{ label: string; expected: string; call: () => Promise<unknown> }> = [
      { label: "ESCROW_SIGNING", expected: "New router authorizations are disabled.",
        call: () => signEscrowAuth({} as Parameters<typeof signEscrowAuth>[0]) },
      { label: "CLAIM_SIGNING", expected: "New router claim-signatures are disabled.",
        call: () => signClaimAuth({} as Parameters<typeof signClaimAuth>[0]) },
      { label: "RELAY_BROADCAST", expected: "Claim relay broadcasts are paused.",
        call: () => assertRouterOperationEnabled("relay-broadcasts") },
    ];
    for (const attempt of deniedAttempts) {
      try {
        await attempt.call();
      } catch (error) {
        if (error instanceof Error && error.message === attempt.expected) {
          process.stdout.write(`KEYLESS_${attempt.label}_REJECTED\n`);
          continue;
        }
        throw error;
      }
      throw new Error(`Keyless ${attempt.label} unexpectedly proceeded.`);
    }
  } else if (mode === "checkpoint-crash") {
    await indexEscrows({
      afterPersistedBlock: async (depositedIds) => {
        if (!depositedIds.includes(targetId)) return;
        await new Promise<void>((resolve) => {
          process.stdout.write("INDEXER_CHECKPOINT_COMMITTED\n", "utf8", () => resolve());
        });
        await new Promise<never>(() => undefined);
      },
    });
  } else {
    await indexEscrows();
    process.stdout.write(`INDEXER_COMPLETED;FAKE_SMS_CALLS=${providerCalls}\n`);
  }
} finally {
  globalThis.fetch = nativeFetch;
  await redis.quit().catch(() => undefined);
  await sql.end({ timeout: 5 }).catch(() => undefined);
}
