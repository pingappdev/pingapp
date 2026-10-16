import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, parseAbiParameters, type Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const chainState = vi.hoisted(() => ({
  latestBlock: 12n,
  timestamp: BigInt(Math.floor(Date.now() / 1000) + 60),
  logs: [] as unknown[],
  logQueries: 0,
}));

vi.mock('../src/lib/viem.js', () => ({ publicClient: {
  getBlockNumber: vi.fn(async () => chainState.latestBlock),
  getBlock: vi.fn(async () => ({ timestamp: chainState.timestamp, hash: `0x${'11'.repeat(32)}` })),
  getLogs: vi.fn(async () => { chainState.logQueries += 1; return chainState.logs; }),
  getBalance: vi.fn(async () => 1_000_000_000_000_000_000n),
  readContract: vi.fn(async () => 0n),
} }));
vi.mock('../src/lib/queue.js', () => ({ enqueue: vi.fn(async () => undefined), getQueue: vi.fn() }));
vi.mock('../src/lib/router.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/router.js')>()),
  getEscrowFee: vi.fn(async () => 0n),
}));
vi.mock('../src/modules/tokens/prices.js', () => ({ getPrices: vi.fn(async () => new Map()) }));
vi.mock('../src/modules/tokens/minimum.js', () => ({ getMinAmountRaw: vi.fn(async () => 0n) }));
vi.mock('../src/modules/tokens/routes.js', () => ({ toTokenDto: (token: unknown) => token }));

const resourcePrefix = process.env.PINGAPP_MONITOR_TEST_RESOURCE_PREFIX ?? '';
if (resourcePrefix && resourcePrefix !== 'pingapp-audit-monitor') {
  throw new Error('PINGAPP_MONITOR_TEST_RESOURCE_PREFIX must be pingapp-audit-monitor.');
}
const enabled = resourcePrefix === 'pingapp-audit-monitor';
const suite = enabled ? describe : describe.skip;
const claimedEvent = parseAbiItem('event Claimed(bytes32 indexed id, address indexed recipient, address indexed relayer, address token, uint256 amount, uint256 claimTip)');
const claimData = parseAbiParameters('address token, uint256 amount, uint256 claimTip');

suite('router monitoring and incident controls (disposable services)', () => {
  let db: any;
  let sql: any;
  let redis: any;
  let schema: any;
  let config: any;
  let readOnlyRepository: any;
  let readOnlySql: any;
  let routerService: any;
  let routerJobs: any;
  let configRoutes: any;
  let app: any;
  let userId = '';
  let tokenAddress = '';
  let escrowId = '';
  let claimedEscrowId = '';
  let escrowCode = '';
  let authorizationRequestId = '';

  function assertDisposableUrl(value: string, portName: string): URL {
    const parsed = new URL(value);
    const expectedPort = process.env[portName];
    if (!expectedPort || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.port !== expectedPort) {
      throw new Error(`Monitor integration requires loopback services on ${portName}.`);
    }
    return parsed;
  }

  beforeAll(async () => {
    if (!process.env.PINGAPP_MONITOR_TEST_POSTGRES_PORT || !process.env.PINGAPP_MONITOR_TEST_REDIS_PORT ||
        !process.env.ROUTER_WATCH_DATABASE_URL) {
      throw new Error('Monitor integration requires explicit disposable PostgreSQL/Redis ports and a read-only watcher URL.');
    }
    const expectedDatabase = resourcePrefix.replaceAll('-', '_');
    const appUrl = assertDisposableUrl(process.env.DATABASE_URL ?? '', 'PINGAPP_MONITOR_TEST_POSTGRES_PORT');
    const watcherUrl = assertDisposableUrl(process.env.ROUTER_WATCH_DATABASE_URL, 'PINGAPP_MONITOR_TEST_POSTGRES_PORT');
    const redisUrl = assertDisposableUrl(process.env.REDIS_URL ?? '', 'PINGAPP_MONITOR_TEST_REDIS_PORT');
    if (appUrl.pathname !== `/${expectedDatabase}` || watcherUrl.pathname !== `/${expectedDatabase}` ||
        appUrl.username === watcherUrl.username || !process.env.PINGAPP_MONITOR_TEST_RESOURCE_PREFIX) {
      throw new Error('Monitor integration must use isolated pingapp_audit_monitor with a separate watcher database role.');
    }
    const [dbClient, redisClient, schemaModule, configModule, watchRepo, serviceModule, jobsModule, routesModule] = await Promise.all([
      import('../src/db/client.js'), import('../src/lib/redis.js'), import('../src/db/schema.js'), import('../src/config.js'),
      import('../src/modules/escrows/watchRepository.js'), import('../src/modules/escrows/service.js'),
      import('../src/modules/escrows/jobs.js'), import('../src/modules/config/routes.js'),
    ]);
    db = dbClient.db;
    sql = dbClient.sql;
    redis = redisClient.redis;
    schema = schemaModule;
    config = configModule.config;
    routerService = serviceModule;
    routerJobs = jobsModule;
    configRoutes = routesModule.default;
    readOnlyRepository = new watchRepo.ReadOnlyRouterWatchRepository(process.env.ROUTER_WATCH_DATABASE_URL);
    const postgres = (await import('postgres')).default;
    readOnlySql = postgres(process.env.ROUTER_WATCH_DATABASE_URL, { max: 1, prepare: false });
    if (config.ROUTER_ENABLED !== true || config.ROUTER_ADDRESS !== '0x0000000000000000000000000000000000000003') {
      throw new Error('Monitor integration must use ROUTER_ENABLED=true and the synthetic disposable router address.');
    }
    if (await sql`select current_database() as name`.then((rows: Array<{ name: string }>) => rows[0]?.name) !== expectedDatabase) {
      throw new Error('Monitor integration database name does not match its resource prefix.');
    }
    await redis.ping();
    await readOnlyRepository.verifyReadOnlyRole();
    await readOnlyRepository.getMetrics(new Date(Date.now() - 60 * 60_000), new Date(Date.now() - 10 * 60_000));

    const Fastify = (await import('fastify')).default;
    app = Fastify();
    await app.register(configRoutes);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close().catch(() => undefined);
    if (authorizationRequestId && db) await db.delete(schema.claimAuthorizations)
      .where(eq(schema.claimAuthorizations.requestId, authorizationRequestId)).catch(() => undefined);
    if (escrowId && db) await db.delete(schema.escrows).where(eq(schema.escrows.id, escrowId)).catch(() => undefined);
    if (claimedEscrowId && db) await db.delete(schema.escrows).where(eq(schema.escrows.id, claimedEscrowId)).catch(() => undefined);
    if (userId && db) await db.delete(schema.users).where(eq(schema.users.id, userId)).catch(() => undefined);
    if (tokenAddress && db) await db.delete(schema.tokens).where(eq(schema.tokens.address, tokenAddress)).catch(() => undefined);
    if (db && schema) await db.delete(schema.kv).where(inArray(schema.kv.key, [
      'router:scope', 'router:lastBlock', 'router:incident:stop:authorizations',
      'router:incident:stop:claim-signatures', 'router:incident:stop:relay-broadcasts',
    ])).catch(() => undefined);
    if (readOnlyRepository) await readOnlyRepository.close().catch(() => undefined);
    if (readOnlySql) await readOnlySql.end({ timeout: 5 }).catch(() => undefined);
    if (redis) await redis.quit().catch(() => undefined);
    if (sql) await sql.end({ timeout: 5 }).catch(() => undefined);
  });

  it('uses a real SELECT-only role and rejects DML, TRUNCATE, ownership and DDL', async () => {
    await expect(readOnlySql`select key from public.kv limit 1`).resolves.toBeDefined();
    const statements = [
      `INSERT INTO public.kv (key, value) VALUES ('monitor-write-probe', 'null'::jsonb)`,
      `UPDATE public.kv SET updated_at = updated_at WHERE false`,
      `DELETE FROM public.kv WHERE false`,
      `TRUNCATE TABLE public.kv`,
      `CREATE TABLE public.monitor_ddl_probe (id integer)`,
      `ALTER TABLE public.kv ADD COLUMN monitor_ddl_probe integer`,
    ];
    for (const statement of statements) {
      const failure = await readOnlySql.begin(async (tx: any) => {
        await tx.unsafe(statement);
        throw new Error('write probe unexpectedly succeeded');
      }).then(() => null, (error: unknown) => error);
      expect(failure).toBeTruthy();
      expect(failure).not.toMatchObject({ message: 'write probe unexpectedly succeeded' });
    }
  });

  it('keeps escrow UI, refund visibility, deposit evidence intake and indexing live under all dedicated stops', async () => {
    const user = randomUUID();
    const senderAddress = `0x${randomBytes(20).toString('hex')}`;
    userId = user;
    tokenAddress = `0x${randomBytes(20).toString('hex')}`;
    escrowId = `0x${randomBytes(32).toString('hex')}`;
    escrowCode = randomBytes(5).toString('hex');
    const txHash = `0x${randomBytes(32).toString('hex')}`;
    await db.insert(schema.users).values({ id: user, address: senderAddress, displayName: 'Monitor test sender' });
    await db.insert(schema.tokens).values({ address: tokenAddress, chainId: 46630, symbol: 'TEST', name: 'Test Token', decimals: 6, kind: 'stable' });
    await db.insert(schema.escrows).values({
      id: escrowId, code: escrowCode, senderUserId: user, senderAddress, recipientPhoneHmac: 'a'.repeat(64),
      recipientPhoneEnc: 'encrypted-fixture', recipientPhoneMasked: '••••0101', deliveryMode: 'claim',
      tokenAddress, amountRaw: '1000000', claimTipWei: '0', feeWei: '0', expiresAt: new Date(Date.now() - 60_000),
      authDeadline: new Date(Date.now() - 60_000), status: 'deposited', depositedAt: new Date(Date.now() - 120_000),
      smsStatus: 'not_required',
    });
    const requestId = randomUUID();
    authorizationRequestId = requestId;
    await db.insert(schema.claimAuthorizations).values({
      requestId, escrowId, kind: 'self', recipientUserId: user, recipientAddress: senderAddress,
      relayerAddress: senderAddress, recipientPhoneHmac: 'b'.repeat(64), phoneLinkedAt: new Date(),
      deadline: new Date(Date.now() + 60_000), domainName: 'PingRouter', domainVersion: '1',
      domainChainId: 4663n, domainVerifyingContract: '0x0000000000000000000000000000000000000003',
      typedDataDigest: `0x${'22'.repeat(32)}`, signedAt: new Date(),
    });
    const authRows = await readOnlyRepository.getClaimAuthorizations(escrowId);
    expect(authRows).toHaveLength(1);
    expect(authRows[0]).toMatchObject({ requestId, kind: 'self', recipientAddress: senderAddress, typedDataDigest: `0x${'22'.repeat(32)}` });

    const { kvSet } = await import('../src/db/kv.js');
    const { routerStopKvKey, readRouterStopState, assertRouterOperationEnabled } = await import('../src/modules/escrows/incident.js');
    for (const operation of ['authorizations', 'claim-signatures', 'relay-broadcasts'] as const) {
      await kvSet(routerStopKvKey(operation), true);
    }
    await expect(readRouterStopState()).resolves.toEqual({ authorizations: true, 'claim-signatures': true, 'relay-broadcasts': true });
    for (const operation of ['authorizations', 'claim-signatures', 'relay-broadcasts'] as const) {
      await expect(assertRouterOperationEnabled(operation)).rejects.toMatchObject({ code: 'CONFLICT' });
    }

    await kvSet(routerStopKvKey('claim-signatures'), false);
    let entered!: () => void;
    let release!: () => void;
    const actionEntered = new Promise<void>((resolve) => { entered = resolve; });
    const heldAction = new Promise<void>((resolve) => { release = resolve; });
    const action = db.transaction(async (tx: any) => {
      await assertRouterOperationEnabled('claim-signatures', tx);
      entered();
      await heldAction;
    });
    await actionEntered;
    let stopped = false;
    const stop = (await import('../src/modules/escrows/incident.js')).withRouterStopWriteLock('claim-signatures', async (tx: any) => {
      await kvSet(routerStopKvKey('claim-signatures'), true, tx);
    }).then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    release();
    await Promise.all([action, stop]);
    await expect(assertRouterOperationEnabled('claim-signatures')).rejects.toMatchObject({ code: 'CONFLICT' });

    const configResponse = await app.inject({ method: 'GET', url: '/config' });
    expect(configResponse.statusCode).toBe(200);
    const publicConfig = configResponse.json();
    expect(publicConfig.features.escrow).toBe(true);
    expect(publicConfig.features.intents).toBe(false);
    expect(publicConfig.router.enabled).toBe(true);

    const router = await routerService.submittedEscrow({ id: user, address: senderAddress }, escrowId, txHash);
    expect(router.depositTxHash).toBe(txHash);
    const sent = await routerService.listEscrows(user, 'sent');
    expect(sent.find((row: { id: string }) => row.id === escrowId)?.refundable).toBe(true);

    chainState.latestBlock = 12n;
    chainState.logs = [];
    chainState.logQueries = 0;
    await routerJobs.indexEscrows();
    expect(chainState.logQueries).toBe(1);
    const { kvGet } = await import('../src/db/kv.js');
    await expect(kvGet('router:lastBlock')).resolves.toBe(13);

    claimedEscrowId = `0x${randomBytes(32).toString('hex')}`;
    const claimedCode = randomBytes(5).toString('hex');
    await db.insert(schema.escrows).values({
      id: claimedEscrowId, code: claimedCode, senderUserId: user, senderAddress, recipientPhoneHmac: 'c'.repeat(64),
      recipientPhoneEnc: 'encrypted-fixture', recipientPhoneMasked: '••••0202', deliveryMode: 'automatic',
      recipientRef: 'fixture-binding', recipientUserId: user, tokenAddress, amountRaw: '1000000',
      claimTipWei: '0', feeWei: '0', expiresAt: new Date(Date.now() + 60_000), authDeadline: new Date(Date.now() + 60_000),
      status: 'claiming', smsStatus: 'not_required',
    });
    const actualRecipient = '0x0000000000000000000000000000000000000099';
    const claimedLog = {
      address: config.ROUTER_ADDRESS,
      topics: encodeEventTopics({ abi: [claimedEvent], eventName: 'Claimed', args: {
        id: claimedEscrowId as `0x${string}`, recipient: actualRecipient as Address, relayer: senderAddress as Address,
      } }),
      data: encodeAbiParameters(claimData, [tokenAddress as Address, 777n, 0n]),
      transactionHash: txHash, blockNumber: 14n, blockHash: `0x${'33'.repeat(32)}`, logIndex: 0,
    };
    const { applyRouterLog } = await import('../src/modules/escrows/events.js');
    await db.transaction(async (tx: any) => {
      await (await import('../src/modules/phone/lock.js')).lockPhoneMutation(tx);
      await applyRouterLog(tx, claimedLog as never, new Date());
    });
    const [reconciled] = await db.select().from(schema.escrows).where(eq(schema.escrows.id, claimedEscrowId));
    expect(reconciled).toMatchObject({ status: 'claimed', claimedToAddress: actualRecipient.toLowerCase(), claimTxHash: txHash });

    for (const operation of ['authorizations', 'claim-signatures', 'relay-broadcasts'] as const) {
      await (await import('../src/modules/escrows/incident.js')).withRouterStopWriteLock(operation, async (tx: any) => {
        await kvSet(routerStopKvKey(operation), false, tx);
      });
    }
  });
});
