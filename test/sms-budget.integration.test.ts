import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const resourcePrefix = process.env.PINGAPP_SMS_TEST_RESOURCE_PREFIX ?? "";
const enabled = /^pingapp-audit-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(resourcePrefix);
const expectedDatabase = resourcePrefix.replaceAll("-", "_");
const suite = enabled ? describe : describe.skip;
const testRunUtcDay = new Date(
  performance.timeOrigin + performance.now(),
).toISOString().slice(0, 10).replaceAll("-", "");
const fixtureDays = [
  "20261021", "20261022", "20261023", "20261024", "20261025", "20261026",
  "20261027", "20261028", "20261029", "20261030", "20261031", "20261101",
  "20261102", "20261103", "20261104", "20261105", testRunUtcDay,
  "20261106", "20261107", "20261108", "20261109", "20261110",
  "20261111", "20261112", "20261113",
];

suite("SMS budgets and delivery recovery (disposable services)", () => {
  let db: any;
  let sql: any;
  let redis: any;
  let config: any;
  let schema: any;
  let crypto: any;
  let sms: any;
  let phoneService: any;
  let escrowEvents: any;
  const createdUserIds: string[] = [];
  const createdTokenAddresses: string[] = [];
  const createdEscrowIds: string[] = [];
  const createdSmsPhoneHashes: string[] = [];
  let networkFetch: ReturnType<typeof vi.fn> | undefined;
  let sevenResponseBody: unknown;

  function setDate(date: string) {
    vi.setSystemTime(new Date(date));
  }

  function smsInput(
    lane: "funded_invite" | "claim_otp" | "onboarding" | "admin_test",
  ) {
    const purpose =
      lane === "funded_invite"
        ? "intent"
        : lane === "admin_test"
          ? "admin_test"
          : "otp";
    const phoneHmac = `test-${randomUUID()}`;
    createdSmsPhoneHashes.push(phoneHmac);
    return {
      purpose,
      budgetLane: lane,
      toE164: "+12025550101",
      text: "Disposable SMS integration fixture.",
      phoneHmac,
      country: "US",
    };
  }

  async function acceptedProvider() {
    return { providerMsgId: "fake-provider-message", priceEur: "0.0100" };
  }

  async function createUser() {
    const id = randomUUID();
    const address = `0x${randomBytes(20).toString("hex")}`;
    await db
      .insert(schema.users)
      .values({ id, address, displayName: "SMS fixture" });
    createdUserIds.push(id);
    return id;
  }

  async function createTokenAndEscrow(
    status: "deposited" | "claimed" | "refunded",
    expiresAt: Date,
    recipient = `+1202555${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, "0")}`,
  ) {
    const tokenAddress = `0x${randomBytes(20).toString("hex")}`;
    const id = `0x${randomBytes(32).toString("hex")}`;
    const code = randomBytes(8).toString("hex").slice(0, 10);
    const depositTxHash = `0x${randomBytes(32).toString("hex")}`;
    const recipientPhoneHmac = crypto.phoneHmac(recipient);
    createdSmsPhoneHashes.push(recipientPhoneHmac);
    createdTokenAddresses.push(tokenAddress);
    createdEscrowIds.push(id);
    await db.insert(schema.tokens).values({
      address: tokenAddress,
      chainId: 4663,
      symbol: "TUSD",
      name: "Test USD",
      decimals: 6,
      kind: "stable",
    });
    await db.insert(schema.escrows).values({
      id,
      code,
      senderAddress: `0x${randomBytes(20).toString("hex")}`,
      recipientPhoneHmac,
      recipientPhoneEnc: crypto.encrypt(recipient),
      recipientPhoneMasked: "••••0111",
      deliveryMode: "claim",
      tokenAddress,
      amountRaw: "1250000",
      claimTipWei: "0",
      feeWei: "0",
      expiresAt,
      authDeadline: new Date(Date.now() + 60_000),
      status,
      smsStatus: "deferred_budget",
      smsAttemptCount: 0,
      smsNextAttemptAt: new Date(Date.now() - 1_000),
      depositTxHash,
      depositedAt: new Date(),
      ...(status === "claimed" ? { claimedAt: new Date() } : {}),
      ...(status === "refunded" ? { refundedAt: new Date() } : {}),
    });
    return { id, code, recipient, recipientPhoneHmac };
  }

  beforeAll(async () => {
    const clientConfig = await import("../src/config.js");
    const dbClient = await import("../src/db/client.js");
    const redisClient = await import("../src/lib/redis.js");
    config = clientConfig.config;
    db = dbClient.db;
    sql = dbClient.sql;
    redis = redisClient.redis;
    schema = await import("../src/db/schema.js");
    crypto = await import("../src/lib/crypto.js");
    sms = await import("../src/lib/sms.js");
    phoneService = await import("../src/modules/phone/service.js");
    escrowEvents = await import("../src/modules/escrows/events.js");

    const databaseUrl = new URL(config.DATABASE_URL);
    const redisUrl = new URL(config.REDIS_URL);
    if (
      !resourcePrefix || databaseUrl.pathname !== `/${expectedDatabase}` ||
      !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) ||
      !process.env.PINGAPP_SMS_TEST_POSTGRES_PORT ||
      databaseUrl.port !== process.env.PINGAPP_SMS_TEST_POSTGRES_PORT ||
      !["127.0.0.1", "localhost"].includes(redisUrl.hostname) ||
      !process.env.PINGAPP_SMS_TEST_REDIS_PORT ||
      redisUrl.port !== process.env.PINGAPP_SMS_TEST_REDIS_PORT
    ) {
      throw new Error(
        "SMS integration tests require loopback services with a database name and ports derived from the explicit disposable resource prefix.",
      );
    }
    if (
      config.SMS_DRIVER !== "seven" || !config.SMS_ENABLED || config.SMS_DAILY_CAP !== 12 ||
      config.SMS_FUNDED_INVITE_DAILY_BUDGET !== 4 || config.SMS_CLAIM_OTP_DAILY_BUDGET !== 4 ||
      config.SMS_ONBOARDING_DAILY_BUDGET !== 3 || config.SMS_ADMIN_DAILY_BUDGET !== 1
    ) {
      throw new Error("F2 integration tests require SMS_DRIVER=seven, SMS_ENABLED=true, cap=12, and lane budgets 4/4/3/1.");
    }
    networkFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "https://gateway.seven.io/api/sms") {
        throw new Error("External network access is disabled in the SMS integration suite.");
      }
      if (sevenResponseBody === undefined) {
        throw new Error("No fake Seven response was configured for this test.");
      }
      const body =
        typeof sevenResponseBody === "string"
          ? sevenResponseBody
          : JSON.stringify(sevenResponseBody);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", networkFetch);
    const counterKeys = fixtureDays.flatMap((day) => [
      `sms:count:${day}`, `sms:count:${day}:funded_invite`, `sms:count:${day}:claim_otp`,
      `sms:count:${day}:onboarding`, `sms:count:${day}:admin_test`, `sms:warned:${day}`,
    ]);
    await redis.del("sms:disabled", ...counterKeys);
    await sms.setSmsKillSwitch(false);
  });

  afterAll(async () => {
    if (db && createdEscrowIds.length) {
      await db
        .delete(schema.escrows)
        .where(inArray(schema.escrows.id, createdEscrowIds))
        .catch(() => undefined);
    }
    if (db && createdTokenAddresses.length) {
      await db
        .delete(schema.tokens)
        .where(inArray(schema.tokens.address, createdTokenAddresses))
        .catch(() => undefined);
    }
    if (db && createdSmsPhoneHashes.length) {
      await db.delete(schema.smsLog).where(inArray(schema.smsLog.phoneHmac, createdSmsPhoneHashes)).catch(() => undefined);
    }
    if (db && createdUserIds.length) {
      await db
        .delete(schema.users)
        .where(inArray(schema.users.id, createdUserIds))
        .catch(() => undefined);
    }
    if (redis && createdUserIds.length) {
      const keys = createdUserIds.flatMap((id) => [
        `otp:${id}`,
        `otp:sequence:${id}`,
        `otp:accepted:${id}`,
      ]);
      if (keys.length) await redis.del(...keys).catch(() => undefined);
    }
    if (redis && createdSmsPhoneHashes.length) {
      const keys = createdSmsPhoneHashes.flatMap((hash) => [
        `rl:intent_phone_sms_day:${hash}`,
        `rl:intent_phone_sms_30d:${hash}`,
        `rl:otp_phone_burst:${hash}`,
        `rl:otp_phone_day:${hash}`,
        `rl:claim_otp_phone_burst:${hash}`,
        `rl:claim_otp_phone_day:${hash}`,
      ]);
      await redis.del(...keys).catch(() => undefined);
    }
    const counterKeys = fixtureDays.flatMap((day) => [
      `sms:count:${day}`, `sms:count:${day}:funded_invite`, `sms:count:${day}:claim_otp`,
      `sms:count:${day}:onboarding`, `sms:count:${day}:admin_test`, `sms:warned:${day}`,
    ]);
    await redis?.del("sms:disabled", ...counterKeys).catch(() => undefined);
    await redis?.quit().catch(() => undefined);
    await sql?.end().catch(() => undefined);
    if (networkFetch) {
      expect(networkFetch.mock.calls.every(([url]) => String(url) === "https://gateway.seven.io/api/sms")).toBe(true);
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("releases a pre-provider reservation and keeps lane capacity separate under concurrency", async () => {
    setDate("2026-10-21T12:00:00.000Z");
    const blockedProvider = vi.fn(acceptedProvider);
    await expect(
      sms.sendSms(smsInput("onboarding"), {
        provider: blockedProvider,
        beforeProvider: async () => {
          throw new (await import("../src/lib/errors.js")).AppError(
            "RATE_LIMITED",
            429,
            "Too many attempts.",
            { retryAfterSec: 60 },
          );
        },
      }),
    ).rejects.toMatchObject({
      outcome: "deferred_rate_limit",
      retryAfterMs: 60_000,
    });
    expect(blockedProvider).not.toHaveBeenCalled();
    expect(await sms.smsSentToday()).toBe(0);

    let providerCalls = 0;
    const provider = async () => {
      providerCalls += 1;
      return acceptedProvider();
    };
    const lanes = [
      "funded_invite",
      "claim_otp",
      "onboarding",
      "admin_test",
    ] as const;
    const settled = await Promise.allSettled(
      lanes.flatMap((lane) =>
        Array.from({ length: 20 }, () =>
          sms.sendSms(smsInput(lane), { provider }),
        ),
      ),
    );
    const accepted = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(12);
    expect(rejected).toHaveLength(68);
    expect(providerCalls).toBe(12);
    expect(await sms.smsSentToday()).toBe(12);
    expect(await redis.get("sms:count:20261021:funded_invite")).toBe("4");
    expect(await redis.get("sms:count:20261021:claim_otp")).toBe("4");
    expect(await redis.get("sms:count:20261021:onboarding")).toBe("3");
    expect(await redis.get("sms:count:20261021:admin_test")).toBe("1");
    expect(await sms.smsAvailable("funded_invite")).toBe(false);
    expect(
      rejected.every(
        (result) =>
          result.status === "rejected" &&
          result.reason.outcome === "deferred_budget",
      ),
    ).toBe(true);
  });

  it("recovers the total and lane counters at the next UTC day", async () => {
    setDate("2026-10-22T23:59:50.000Z");
    await sms.sendSms(smsInput("onboarding"), { provider: acceptedProvider });
    expect(await sms.smsSentToday()).toBe(1);
    setDate("2026-10-23T00:00:02.000Z");
    expect(await sms.smsSentToday()).toBe(0);
    expect(await sms.smsAvailable("onboarding")).toBe(true);
    await sms.sendSms(smsInput("onboarding"), { provider: acceptedProvider });
    expect(await sms.smsSentToday()).toBe(1);
  });

  it("keeps the current OTP after a budget-blocked resend and a stale concurrent failure", async () => {
    setDate("2026-10-24T12:00:00.000Z");
    const userId = await createUser();
    const oldPhone = `+1202555${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, "0")}`;
    const oldHash = crypto.phoneHmac(oldPhone);
    createdSmsPhoneHashes.push(oldHash);
    const oldCode = "284613";
    await redis.set(
      `otp:${userId}`,
      JSON.stringify({
        phoneHmac: oldHash,
        codeHash: crypto.sha256Hex(`${oldCode}:${oldHash}:${userId}`),
        attempts: 0,
        createdAt: Date.now(),
        generation: 1,
      }),
      "EX",
      600,
    );

    for (let i = 0; i < 3; i += 1) {
      await sms.sendSms(smsInput("onboarding"), { provider: acceptedProvider });
    }
    const neverCalled = vi.fn(acceptedProvider);
    const blockedPhone = `+1202555${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, "0")}`;
    createdSmsPhoneHashes.push(crypto.phoneHmac(blockedPhone));
    await expect(
      phoneService.requestOtp(
        userId,
        "unused",
        blockedPhone,
        randomUUID(),
        undefined,
        neverCalled,
      ),
    ).rejects.toMatchObject({ outcome: "deferred_budget" });
    expect(neverCalled).not.toHaveBeenCalled();
    const currentAfterBudgetBlock = JSON.parse(
      await redis.get(`otp:${userId}`),
    );
    expect(
      (await import("../src/modules/phone/otp.js")).checkOtp(
        currentAfterBudgetBlock,
        oldHash,
        userId,
        oldCode,
      ).result,
    ).toBe("ok");

    setDate("2026-10-25T12:00:00.000Z");
    const oldPhoneA = `+1202555${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, "0")}`;
    const oldPhoneB = `+1202555${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, "0")}`;
    createdSmsPhoneHashes.push(crypto.phoneHmac(oldPhoneA), crypto.phoneHmac(oldPhoneB));
    let signalAStarted!: () => void;
    let releaseA!: () => void;
    const startedA = new Promise<void>((resolve) => {
      signalAStarted = resolve;
    });
    const delayedA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const providerA = async () => {
      signalAStarted();
      await delayedA;
      throw new sms.SmsProviderRejected("fixture_rejected");
    };
    const failedA = phoneService
      .requestOtp(
        userId,
        "unused",
        oldPhoneA,
        randomUUID(),
        undefined,
        providerA,
      )
      .catch((error: unknown) => error);
    await startedA;
    let acceptedCodeB = "";
    const providerB = async (input: { text: string }) => {
      acceptedCodeB = input.text.match(/code is (\d{6})/)?.[1] ?? "";
      return acceptedProvider();
    };
    await phoneService.requestOtp(
      userId,
      "unused",
      oldPhoneB,
      randomUUID(),
      undefined,
      providerB,
    );
    releaseA();
    await expect(failedA).resolves.toMatchObject({
      outcome: "provider_rejected",
    });
    expect(acceptedCodeB).toMatch(/^\d{6}$/);
    const newest = JSON.parse(await redis.get(`otp:${userId}`));
    expect(newest.phoneHmac).toBe(crypto.phoneHmac(oldPhoneB));
    expect(
      (await import("../src/modules/phone/otp.js")).checkOtp(
        newest,
        crypto.phoneHmac(oldPhoneB),
        userId,
        acceptedCodeB,
      ).result,
    ).toBe("ok");
  });

  it("uses the funded claim OTP lane only with a matching confirmed deposit and claim code", async () => {
    setDate("2026-10-29T12:00:00.000Z");
    const recipient = `+1202555${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, "0")}`;
    const funded = await createTokenAndEscrow("deposited", new Date(Date.now() + 60_000), recipient);
    const attackerUser = await createUser();
    // A phone-only onboarding request consumes the ordinary phone burst/day budget.
    await phoneService.requestOtp(attackerUser, "unused", recipient, randomUUID(), undefined, acceptedProvider);
    for (let i = 0; i < 2; i += 1)
      await sms.sendSms(smsInput("onboarding"), { provider: acceptedProvider });
    const userId = await createUser();
    let sentCode = "";
    const provider = async (input: { text: string }) => {
      sentCode = input.text.match(/code is (\d{6})/)?.[1] ?? "";
      return acceptedProvider();
    };
    await phoneService.requestOtp(userId, "unused", recipient, randomUUID(), funded.code, provider);
    expect(sentCode).toMatch(/^\d{6}$/);
    const current = JSON.parse(await redis.get(`otp:${userId}`));
    expect(current.phoneHmac).toBe(funded.recipientPhoneHmac);
    expect((await import("../src/modules/phone/otp.js")).checkOtp(
      current, funded.recipientPhoneHmac, userId, sentCode,
    ).result).toBe("ok");

    const otherUser = await createUser();
    const rejectedProvider = vi.fn(acceptedProvider);
    await expect(phoneService.requestOtp(
      otherUser, "unused", recipient, randomUUID(), undefined, rejectedProvider,
    )).rejects.toMatchObject({ outcome: "deferred_budget" });
    expect(rejectedProvider).not.toHaveBeenCalled();
  });

  it("allows an older accepted OTP to promote after a newer request is rejected", async () => {
    setDate("2026-10-30T12:00:00.000Z");
    const userId = await createUser();
    const olderPhone = `+1202555${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, "0")}`;
    const newerPhone = `+1202555${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, "0")}`;
    const olderHash = crypto.phoneHmac(olderPhone);
    const newerHash = crypto.phoneHmac(newerPhone);
    createdSmsPhoneHashes.push(olderHash, newerHash);
    let signalOlderStarted!: () => void;
    let releaseOlder!: () => void;
    const olderStarted = new Promise<void>((resolve) => { signalOlderStarted = resolve; });
    const olderRelease = new Promise<void>((resolve) => { releaseOlder = resolve; });
    let olderCode = "";
    const acceptedOlder = async (input: { text: string }) => {
      olderCode = input.text.match(/code is (\d{6})/)?.[1] ?? "";
      signalOlderStarted();
      await olderRelease;
      return acceptedProvider();
    };
    const olderRequest = phoneService.requestOtp(userId, "unused", olderPhone, randomUUID(), undefined, acceptedOlder);
    await olderStarted;
    await expect(phoneService.requestOtp(
      userId, "unused", newerPhone, randomUUID(), undefined,
      async () => { throw new sms.SmsProviderRejected("fixture_rejected"); },
    )).rejects.toMatchObject({ outcome: "provider_rejected" });
    releaseOlder();
    await olderRequest;
    const current = JSON.parse(await redis.get(`otp:${userId}`));
    expect(current.phoneHmac).toBe(olderHash);
    expect(olderCode).toMatch(/^\d{6}$/);
    expect((await import("../src/modules/phone/otp.js")).checkOtp(
      current, olderHash, userId, olderCode,
    ).result).toBe("ok");
  });

  it("does not resurrect an older OTP after a newer accepted OTP was consumed", async () => {
    setDate("2026-10-31T12:00:00.000Z");
    const userId = await createUser();
    const [session] = await db.insert(schema.sessions).values({
      userId,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    }).returning({ id: schema.sessions.id });
    const olderPhone = `+1202555${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, "0")}`;
    const newerPhone = `+1202555${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, "0")}`;
    const olderHash = crypto.phoneHmac(olderPhone);
    createdSmsPhoneHashes.push(olderHash, crypto.phoneHmac(newerPhone));
    let signalOlderStarted!: () => void;
    let releaseOlder!: () => void;
    const olderStarted = new Promise<void>((resolve) => { signalOlderStarted = resolve; });
    const olderRelease = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const acceptedOlder = async () => {
      signalOlderStarted();
      await olderRelease;
      return acceptedProvider();
    };
    const olderRequest = phoneService.requestOtp(userId, "unused", olderPhone, randomUUID(), undefined, acceptedOlder);
    await olderStarted;
    let newerCode = "";
    const acceptedNewer = async (input: { text: string }) => {
      newerCode = input.text.match(/code is (\d{6})/)?.[1] ?? "";
      return acceptedProvider();
    };
    await phoneService.requestOtp(userId, "unused", newerPhone, randomUUID(), undefined, acceptedNewer);
    await phoneService.verifyOtp(userId, session.id, newerPhone, newerCode, randomUUID());
    expect(await redis.get(`otp:${userId}`)).toBeNull();
    releaseOlder();
    await olderRequest;
    expect(await redis.get(`otp:${userId}`)).toBeNull();
    expect(await redis.get(`otp:accepted:${userId}`)).toBe("2");
  });

  it("keeps unknown provider outcomes out of automatic retry and ignores settled or expired escrows", async () => {
    setDate("2026-11-01T12:00:00.000Z");
    const pending = await createTokenAndEscrow(
      "deposited",
      new Date(Date.now() + 60_000),
    );
    let providerCalls = 0;
    const uncertain = async () => {
      providerCalls += 1;
      throw new Error("timeout after request start");
    };
    await escrowEvents.sendEscrowInvite(pending.id, uncertain);
    await escrowEvents.sendEscrowInvite(pending.id, uncertain);
    const [unknown] = await db
      .select()
      .from(schema.escrows)
      .where(eq(schema.escrows.id, pending.id));
    expect(providerCalls).toBe(1);
    expect(unknown.smsStatus).toBe("provider_unknown");
    expect(unknown.smsAttemptCount).toBe(1);
    expect(unknown.smsNextAttemptAt).toBeNull();

    const settled = [
      await createTokenAndEscrow("claimed", new Date(Date.now() + 60_000)),
      await createTokenAndEscrow("refunded", new Date(Date.now() + 60_000)),
      await createTokenAndEscrow("deposited", new Date(Date.now() - 1_000)),
    ];
    for (const row of settled)
      await escrowEvents.sendEscrowInvite(row.id, uncertain);
    expect(providerCalls).toBe(1);
  });

  it("retries a budget-deferred funded invite after UTC rollover exactly once", async () => {
    setDate("2026-11-03T23:59:50.000Z");
    for (let i = 0; i < 4; i += 1)
      await sms.sendSms(smsInput("funded_invite"), { provider: acceptedProvider });
    const pending = await createTokenAndEscrow("deposited", new Date(Date.now() + 2 * 24 * 60 * 60_000));
    const provider = vi.fn(acceptedProvider);
    await escrowEvents.sendEscrowInvite(pending.id, provider);
    expect(provider).not.toHaveBeenCalled();
    let [deferred] = await db.select().from(schema.escrows).where(eq(schema.escrows.id, pending.id));
    expect(deferred.smsStatus).toBe("deferred_budget");
    expect(deferred.smsAttemptCount).toBe(0);
    expect(deferred.smsNextAttemptAt.toISOString()).toBe("2026-11-04T00:00:00.000Z");

    setDate("2026-11-04T00:00:02.000Z");
    await escrowEvents.sendEscrowInvite(pending.id, provider);
    await escrowEvents.sendEscrowInvite(pending.id, provider);
    [deferred] = await db.select().from(schema.escrows).where(eq(schema.escrows.id, pending.id));
    expect(provider).toHaveBeenCalledOnce();
    expect(deferred.smsStatus).toBe("sent");
    expect(deferred.smsAttemptCount).toBe(1);
    expect(deferred.smsNextAttemptAt).toBeNull();
  });

  it("recovers a persisted due invite from a fresh process", async () => {
    setDate(new Date(performance.timeOrigin + performance.now()).toISOString());
    const fixture = await createTokenAndEscrow(
      "deposited",
      new Date(Date.now() + 60_000),
    );
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "test/helpers/sms-invite-restart-probe.ts"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PINGAPP_SMS_RESTART_ESCROW_ID: fixture.id,
        },
      },
    );
    expect(output).toContain("SMS_RESTART_PROVIDER_CALLS=1");
    const [row] = await db
      .select({ smsStatus: schema.escrows.smsStatus, smsAttemptCount: schema.escrows.smsAttemptCount })
      .from(schema.escrows)
      .where(eq(schema.escrows.id, fixture.id))
      .limit(1);
    expect(row).toMatchObject({ smsStatus: "sent", smsAttemptCount: 1 });
  });

  it("records explicit provider rejection with bounded retry state", async () => {
    setDate("2026-11-05T12:00:00.000Z");
    const pending = await createTokenAndEscrow("deposited", new Date(Date.now() + 3 * 24 * 60 * 60_000));
    const rejected = vi.fn(async () => { throw new sms.SmsProviderRejected("fixture_rejected"); });
    await escrowEvents.sendEscrowInvite(pending.id, rejected);
    await escrowEvents.sendEscrowInvite(pending.id, rejected);
    const [row] = await db.select().from(schema.escrows).where(eq(schema.escrows.id, pending.id));
    expect(rejected).toHaveBeenCalledOnce();
    expect(row.smsStatus).toBe("provider_rejected");
    expect(row.smsAttemptCount).toBe(1);
    expect(row.smsNextAttemptAt.getTime()).toBe(Date.now() + 15 * 60_000);
  });

  it("keeps ambiguous Seven replies spent and releases only documented pre-acceptance rejections", async () => {
    const uncertainCases: Array<{ day: string; response: unknown }> = [
      { day: "2026-11-06", response: { success: "101" } },
      { day: "2026-11-07", response: { success: "600" } },
      { day: "2026-11-08", response: { success: "402" } },
      { day: "2026-11-09", response: "{" },
      {
        day: "2026-11-10",
        response: {
          success: "100",
          total_price: 0,
          messages: [{ success: false, error: 202, price: 0 }],
        },
      },
      {
        day: "2026-11-11",
        response: { success: "500", total_price: 0.01 },
      },
    ];

    for (const { day, response } of uncertainCases) {
      setDate(`${day}T12:00:00.000Z`);
      sevenResponseBody = response;
      await expect(sms.sendSms(smsInput("onboarding"))).rejects.toMatchObject({
        outcome: "provider_unknown",
      });
      expect(await sms.smsSentToday()).toBe(1);
    }

    setDate("2026-11-12T12:00:00.000Z");
    sevenResponseBody = {
      success: "201",
      total_price: 0,
      messages: [{ success: false, error: 201, price: 0 }],
    };
    await expect(sms.sendSms(smsInput("onboarding"))).rejects.toMatchObject({
      outcome: "provider_rejected",
    });
    expect(await sms.smsSentToday()).toBe(0);
    expect(networkFetch).toHaveBeenCalledTimes(7);
    sevenResponseBody = undefined;
  });

  it("accepts a 101 only when the sole requested message explicitly failed", async () => {
    setDate("2026-11-13T13:00:00.000Z");
    sevenResponseBody = {
      success: "101",
      total_price: 0,
      messages: [{ success: false, error: 202, price: 0 }],
    };
    await expect(sms.sendSms(smsInput("onboarding"))).rejects.toMatchObject({
      outcome: "provider_rejected",
    });
    expect(await sms.smsSentToday()).toBe(0);
    sevenResponseBody = undefined;
  });

  it("honors the SMS kill switch before provider invocation", async () => {
    setDate("2026-11-02T12:00:00.000Z");
    await sms.setSmsKillSwitch(true);
    const provider = vi.fn(acceptedProvider);
    await expect(
      sms.sendSms(smsInput("funded_invite"), { provider }),
    ).rejects.toMatchObject({ outcome: "disabled" });
    expect(provider).not.toHaveBeenCalled();
    expect(await sms.smsSentToday()).toBe(0);
    await sms.setSmsKillSwitch(false);
    await sms.sendSms(smsInput("funded_invite"), { provider });
    expect(provider).toHaveBeenCalledOnce();
  });
});
