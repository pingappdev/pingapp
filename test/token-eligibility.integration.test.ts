import { randomBytes } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const integrationDescribe = process.env.TOKEN_ELIGIBILITY_INTEGRATION === '1' ? describe : describe.skip;

integrationDescribe('AUD-09 token eligibility integration', () => {
  let db: typeof import('../src/db/client.js')['db'];
  let sql: typeof import('../src/db/client.js')['sql'];
  let chain: typeof import('../src/lib/chain.js')['chain'];
  let config: typeof import('../src/config.js')['config'];
  let chainId: number;
  let tokens: typeof import('../src/db/schema.js')['tokens'];
  let blocks: typeof import('../src/db/schema.js')['tokenEligibilityBlocks'];
  let changes: typeof import('../src/db/schema.js')['tokenMultiplierChanges'];
  let persistSnapshot: typeof import('../src/modules/tokens/registry.js')['persistStockRegistrySnapshot'];
  let assertEligible: typeof import('../src/modules/tokens/eligibility.js')['assertNewEscrowTokenEligible'];
  let blockToken: typeof import('../src/modules/tokens/eligibility.js')['blockTokenForNewAuthorizations'];
  let unblockToken: typeof import('../src/modules/tokens/eligibility.js')['unblockTokenForNewAuthorizations'];
  let addresses: string[];

  beforeAll(async () => {
    [{ db, sql }, { tokens, tokenEligibilityBlocks: blocks, tokenMultiplierChanges: changes },
      { chain }, { persistStockRegistrySnapshot: persistSnapshot },
      { assertNewEscrowTokenEligible: assertEligible, blockTokenForNewAuthorizations: blockToken,
        unblockTokenForNewAuthorizations: unblockToken }, { config }] = await Promise.all([
      import('../src/db/client.js'),
      import('../src/db/schema.js'),
      import('../src/lib/chain.js'),
      import('../src/modules/tokens/registry.js'),
      import('../src/modules/tokens/eligibility.js'),
      import('../src/config.js'),
    ]);
    const resourcePrefix = process.env.PINGAPP_AUD09_RESOURCE_PREFIX ?? '';
    const databaseUrl = new URL(config.DATABASE_URL);
    if (!/^pingapp-audit-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(resourcePrefix) ||
        databaseUrl.pathname !== `/${resourcePrefix.replaceAll('-', '_')}` ||
        !['127.0.0.1', 'localhost'].includes(databaseUrl.hostname) ||
        !process.env.PINGAPP_AUD09_POSTGRES_PORT || databaseUrl.port !== process.env.PINGAPP_AUD09_POSTGRES_PORT) {
      throw new Error('AUD-09 token eligibility tests require the matching explicitly prefixed loopback disposable PostgreSQL service.');
    }
    chainId = chain.id;
    const id = randomBytes(2).toString('hex');
    addresses = Array.from({ length: 5 }, (_, index) =>
      '0x' + (id + index.toString(16).padStart(2, '0')).padEnd(40, String(index + 1)));
  }, 120_000);

  afterAll(async () => {
    if (addresses?.length) {
      await db.delete(blocks).where(inArray(blocks.tokenAddress, addresses));
      await db.delete(changes).where(inArray(changes.tokenAddress, addresses));
      await db.delete(tokens).where(inArray(tokens.address, addresses));
    }
    await sql?.end();
  }, 120_000);

  async function resetTokens() {
    await db.delete(blocks).where(inArray(blocks.tokenAddress, addresses));
    await db.delete(changes).where(inArray(changes.tokenAddress, addresses));
    await db.delete(tokens).where(inArray(tokens.address, addresses));
    await db.insert(tokens).values([
      { address: addresses[0], chainId, symbol: 'A', name: 'A', decimals: 6, kind: 'stock',
        multiplier: '0.5', multiplierKnown: true, active: true, sort: 1000 },
      { address: addresses[1], chainId, symbol: 'B', name: 'B', decimals: 6, kind: 'stock',
        multiplier: '1', multiplierKnown: true, active: true, sort: 1001 },
      { address: addresses[2], chainId, symbol: 'C', name: 'C', decimals: 6, kind: 'stock',
        multiplier: '1', multiplierKnown: false, active: true, sort: 1002 },
      { address: addresses[4], chainId, symbol: 'E', name: 'E', decimals: 6, kind: 'stock',
        multiplier: '1', multiplierKnown: true, active: true, sort: 1004 },
    ]);
  }

  function snapshot(address: string, symbol: string, issuerMultiplier: string | null) {
    return {
      address, chainId, symbol, name: symbol, decimals: 6, kind: 'stock' as const, logoUrl: null,
      rhAssetId: 'test-' + symbol, active: true, sort: 1000, issuerMultiplier,
    };
  }

  it('normalizes multiplier formatting, blocks only a changed known token, and preserves blocks across refreshes', async () => {
    await resetTokens();
    await persistSnapshot([
      snapshot(addresses[0], 'A', '0.5000'),
      snapshot(addresses[1], 'B', '2.00'),
      snapshot(addresses[2], 'C', '3'),
      snapshot(addresses[3], 'D', '4'),
    ]);
    const savedBlocks = await db.select().from(blocks).where(inArray(blocks.tokenAddress, addresses));
    const savedChanges = await db.select().from(changes).where(inArray(changes.tokenAddress, addresses));
    expect(savedBlocks.map((row) => [row.tokenAddress, row.source, row.observedMultiplier]),
      JSON.stringify(savedBlocks.map((row) => ({ tokenAddress: row.tokenAddress, source: row.source,
        observedMultiplier: row.observedMultiplier })), null, 2)).toEqual([
      [addresses[1], 'issuer_multiplier_change', '2'],
    ]);
    expect(savedChanges.map((row) => [row.tokenAddress, row.previousMultiplier, row.currentMultiplier])).toEqual([
      [addresses[1], '1', '2'],
    ]);

    await blockToken(addresses[0], 'Manual transfer-compatibility review');
    const manualRevision = (await db.select().from(blocks).where(inArray(blocks.tokenAddress, [addresses[0]])))[0]!.reviewRevision;
    await persistSnapshot([
      snapshot(addresses[0], 'A', '0.50'),
      snapshot(addresses[1], 'B', '2.000'),
      snapshot(addresses[2], 'C', '3.00'),
      snapshot(addresses[3], 'D', '4.0'),
    ]);
    const refreshed = await db.select().from(blocks).where(inArray(blocks.tokenAddress, addresses));
    expect(refreshed.map((row) => [row.tokenAddress, row.source]).sort((left, right) => left[0].localeCompare(right[0])))
      .toEqual([[addresses[0], 'operator'], [addresses[1], 'issuer_multiplier_change']]
        .sort((left, right) => left[0].localeCompare(right[0])));
    expect(refreshed.find((row) => row.tokenAddress === addresses[0])?.reviewRevision).toBe(manualRevision);
    expect(await db.select().from(changes).where(inArray(changes.tokenAddress, addresses))).toHaveLength(1);
    await expect(db.transaction((tx) => assertEligible(tx, addresses[0])))
      .rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(db.transaction((tx) => assertEligible(tx, addresses[1])))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    const firstReviewRevision = refreshed.find((row) => row.tokenAddress === addresses[1])!.reviewRevision;
    await expect(unblockToken(addresses[1], '00000000-0000-4000-8000-000000000000', '2'))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await unblockToken(addresses[1], firstReviewRevision, '2');
    await expect(db.transaction((tx) => assertEligible(tx, addresses[1]))).resolves.toMatchObject({
      address: addresses[1], active: true,
    });

    await persistSnapshot([
      snapshot(addresses[0], 'A', '0.50'),
      snapshot(addresses[1], 'B', '1'),
      snapshot(addresses[2], 'C', '3'),
      snapshot(addresses[3], 'D', '4'),
    ]);
    const reviewForA = (await db.select().from(blocks).where(inArray(blocks.tokenAddress, [addresses[1]])))[0]!.reviewRevision;
    await persistSnapshot([
      snapshot(addresses[0], 'A', '0.50'),
      snapshot(addresses[1], 'B', '2.00'),
      snapshot(addresses[2], 'C', '3'),
      snapshot(addresses[3], 'D', '4'),
    ]);
    const reviewForLatestB = (await db.select().from(blocks).where(inArray(blocks.tokenAddress, [addresses[1]])))[0]!.reviewRevision;
    expect(reviewForLatestB).not.toBe(reviewForA);
    await expect(unblockToken(addresses[1], reviewForA, '2'))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await unblockToken(addresses[1], reviewForLatestB, '2');
    await expect(db.transaction((tx) => assertEligible(tx, addresses[1]))).resolves.toMatchObject({
      address: addresses[1], active: true,
    });
  }, 120_000);

  it('serializes a block with an in-flight authorization at the token-row boundary', async () => {
    await resetTokens();
    let release!: () => void;
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const authorization = db.transaction(async (tx) => {
      const token = await assertEligible(tx, addresses[0]);
      signalLocked();
      await resume;
      return token.address;
    });
    await locked;
    let blockFinished = false;
    const block = blockToken(addresses[0], 'Operator compatibility review').then(() => { blockFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(blockFinished).toBe(false);
    release();
    await expect(authorization).resolves.toBe(addresses[0]);
    await block;
    await expect(db.transaction((tx) => assertEligible(tx, addresses[0])))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  }, 120_000);
});
