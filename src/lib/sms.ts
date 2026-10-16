import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { smsLog } from "../db/schema.js";
import { config } from "../config.js";
import { AppError } from "./errors.js";
import { fetchJson } from "./http.js";
import { logger } from "./logger.js";
import { redis } from "./redis.js";

export type SmsPurpose = "otp" | "intent" | "admin_test";
export type SmsBudgetLane =
  "funded_invite" | "claim_otp" | "onboarding" | "admin_test";
export type SmsOutcome =
  | "sent"
  | "deferred_budget"
  | "deferred_rate_limit"
  | "provider_rejected"
  | "provider_unknown"
  | "disabled"
  | "not_required";

export type SmsInput = {
  toE164: string;
  text: string;
  purpose: SmsPurpose;
  budgetLane?: SmsBudgetLane;
  phoneHmac: string;
  country: string | null;
};

type SevenSmsResponse = {
  success?: string | number;
  messages?: Array<{
    id?: string | number | null;
    success?: boolean | string | number;
    error?: string | number | { code?: string | number } | null;
    price?: string | number | null;
  }>;
  total_price?: string | number | null;
  error?: string | number | { code?: string | number } | null;
};

type ProviderResult = { providerMsgId: string | null; priceEur: string | null };
export type SmsProvider = (
  input: SmsInput,
  foreignId: string,
) => Promise<ProviderResult>;
export type SmsOptions = {
  beforeProvider?: () => Promise<void>;
  provider?: SmsProvider;
};

/** Internal reason is available to worker code and is omitted from HTTP error details. */
export class SmsDeliveryError extends AppError {
  constructor(
    public outcome: SmsOutcome,
    public retryAfterMs?: number,
  ) {
    super(
      "SMS_UNAVAILABLE",
      503,
      "Text messages are temporarily unavailable. Please try again later.",
    );
    this.name = "SmsDeliveryError";
  }
}

export class SmsProviderRejected extends Error {
  constructor(
    public providerCode: string,
    public priceEur: string | null = null,
  ) {
    super(providerCode);
    this.name = "SmsProviderRejected";
  }
}

const COUNTER_TTL_SEC = 2 * 24 * 60 * 60;
const PRE_PROVIDER_RETRY_MS = 5 * 60 * 1000;
const KILL_SWITCH_KEY = "sms:disabled";

const RESERVE_SCRIPT = `
if redis.call('GET', KEYS[3]) == '1' then
  return {-1, 0}
end

local total = tonumber(redis.call('GET', KEYS[1]) or '0')
local lane = tonumber(redis.call('GET', KEYS[2]) or '0')
if total >= tonumber(ARGV[1]) or lane >= tonumber(ARGV[2]) then
  return {0, 0}
end

local reservationCreated = redis.call('SET', KEYS[4], '1', 'EX', ARGV[3], 'NX')
if not reservationCreated then
  return {-2, 0}
end

local nextTotal = redis.call('INCR', KEYS[1])
local nextLane = redis.call('INCR', KEYS[2])
if nextTotal == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
if nextLane == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end

local warned = 0
if nextTotal >= tonumber(ARGV[4]) then
  local firstWarning = redis.call('SET', KEYS[5], '1', 'EX', ARGV[3], 'NX')
  if firstWarning then warned = 1 end
end

return {nextTotal, warned}
`;

const AVAILABLE_SCRIPT = `
if redis.call('GET', KEYS[3]) == '1' then return 0 end
local total = tonumber(redis.call('GET', KEYS[1]) or '0')
local lane = tonumber(redis.call('GET', KEYS[2]) or '0')
if total >= tonumber(ARGV[1]) or lane >= tonumber(ARGV[2]) then return 0 end
return 1
`;

const RELEASE_SCRIPT = `
if redis.call('DEL', KEYS[3]) == 0 then return 0 end
for i = 1, 2 do
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  if current <= 1 then redis.call('DEL', KEYS[i]) else redis.call('DECR', KEYS[i]) end
end
return 1
`;

const laneLimit: Record<SmsBudgetLane, number> = {
  funded_invite: config.SMS_FUNDED_INVITE_DAILY_BUDGET,
  claim_otp: config.SMS_CLAIM_OTP_DAILY_BUDGET,
  onboarding: config.SMS_ONBOARDING_DAILY_BUDGET,
  admin_test: config.SMS_ADMIN_DAILY_BUDGET,
};

function inputLane(input: SmsInput): SmsBudgetLane {
  if (input.budgetLane) return input.budgetLane;
  // Keep existing callers on bounded allocations while reserving the admin lane.
  return input.purpose === "admin_test" ? "admin_test" : "onboarding";
}

function utcDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function counterKey(day = utcDayKey()): string {
  // Keep the historical total counter key for the admin report.
  return `sms:count:${day}`;
}

function laneCounterKey(lane: SmsBudgetLane, day = utcDayKey()): string {
  return `sms:count:${day}:${lane}`;
}

function millisUntilUtcRollover(now = new Date()): number {
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return tomorrow.getTime() - now.getTime();
}

function asProviderCode(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const code = String(value).trim();
  return /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : null;
}

function priceEur(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999_999.9999)
    return null;
  return amount.toFixed(4);
}

const DEFINITE_PRE_ACCEPTANCE_CODES = new Set([
  "201", // invalid sender
  "202", // invalid recipient
  "301", // missing recipient parameter
  "305", // invalid text
  "308", // unsupported parameter
  "401", // text too long
  "403", // recipient daily limit
  "500", // insufficient account credit
  "603", // custom domain required
  "802", // invalid label
  "900", // authentication failed
  "901", // signing hash verification failed
  "902", // API key lacks endpoint access
  "903", // source IP is not permitted
]);

type SevenResponseClassification =
  | { kind: "accepted"; result: ProviderResult }
  | { kind: "rejected"; code: string; priceEur: string | null }
  | { kind: "unknown" };

function responseCode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    return asProviderCode((value as { code?: unknown }).code);
  }
  return asProviderCode(value);
}

function classifySevenResponse(value: unknown): SevenResponseClassification {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { kind: "unknown" };

  const response = value as SevenSmsResponse;
  const successCode = asProviderCode(response.success);
  if (!successCode) return { kind: "unknown" };
  if (response.messages !== undefined && !Array.isArray(response.messages))
    return { kind: "unknown" };

  let totalPrice: string | null = null;
  if (response.total_price !== undefined && response.total_price !== null) {
    totalPrice = priceEur(response.total_price);
    if (totalPrice === null) return { kind: "unknown" };
  }

  const topErrorCode = responseCode(response.error);
  if (response.error !== undefined && response.error !== null && !topErrorCode)
    return { kind: "unknown" };
  if (topErrorCode && topErrorCode !== successCode)
    return { kind: "unknown" };

  const messages = response.messages ?? [];
  let hasAcceptanceEvidence = totalPrice !== null && Number(totalPrice) > 0;
  let hasSingleRecipientFailureEvidence = false;
  for (const messageValue of messages) {
    if (!messageValue || typeof messageValue !== "object" || Array.isArray(messageValue))
      return { kind: "unknown" };
    const message = messageValue as NonNullable<SevenSmsResponse["messages"]>[number];

    if (message.id !== undefined && message.id !== null) {
      if (
        (typeof message.id !== "string" && typeof message.id !== "number") ||
        String(message.id).trim() === ""
      ) {
        return { kind: "unknown" };
      }
      hasAcceptanceEvidence = true;
    }

    if (message.success !== undefined) {
      if (
        message.success === true ||
        message.success === 1 ||
        String(message.success) === "100"
      ) {
        hasAcceptanceEvidence = true;
      } else if (
        message.success !== false &&
        message.success !== 0 &&
        String(message.success).toLowerCase() !== "false"
      ) {
        return { kind: "unknown" };
      }
    }

    if (message.price !== undefined && message.price !== null) {
      const messagePrice = priceEur(message.price);
      if (messagePrice === null) return { kind: "unknown" };
      if (Number(messagePrice) > 0) hasAcceptanceEvidence = true;
    }

    const messageErrorCode = responseCode(message.error);
    if (message.error !== undefined && message.error !== null && !messageErrorCode)
      return { kind: "unknown" };
    if (
      message.success === false &&
      messageErrorCode !== null &&
      message.id == null &&
      (message.price == null || priceEur(message.price) === "0.0000") &&
      (totalPrice === null || totalPrice === "0.0000")
    ) {
      hasSingleRecipientFailureEvidence = true;
    }
  }

  if (successCode === "100") {
    // A top-level success paired with a reported failure or nonzero charge is
    // contradictory. Preserve the budget and require reconciliation.
    if (
      messages.some((message) =>
        message.error != null || message.success === false || message.success === 0,
      )
    ) {
      return { kind: "unknown" };
    }
    return {
      kind: "accepted",
      result: {
        providerMsgId:
          messages[0]?.id == null ? null : String(messages[0].id),
        priceEur: totalPrice,
      },
    };
  }

  // 402 can indicate an earlier accepted duplicate; 600 is an in-send error.
  // Code 101 is partial/ambiguous unless the only requested recipient is
  // explicitly marked failed with its own error and no acceptance/charge data.
  if (hasAcceptanceEvidence) return { kind: "unknown" };
  if (successCode === "101") {
    if (
      messages.length === 1 &&
      hasSingleRecipientFailureEvidence &&
      !messages.some((message) => message.success === true || message.success === 1)
    ) {
      const messageCode = responseCode(messages[0]?.error);
      if (messageCode && DEFINITE_PRE_ACCEPTANCE_CODES.has(messageCode)) {
        return { kind: "rejected", code: messageCode, priceEur: totalPrice };
      }
    }
    return { kind: "unknown" };
  }
  if (successCode === "402" || successCode === "600")
    return { kind: "unknown" };

  if (!DEFINITE_PRE_ACCEPTANCE_CODES.has(successCode))
    return { kind: "unknown" };

  return {
    kind: "rejected",
    code: successCode,
    priceEur: totalPrice,
  };
}

async function writeRejectedAttempt(
  input: SmsInput,
  errorCode: string,
): Promise<void> {
  try {
    await db.insert(smsLog).values({
      purpose: input.purpose,
      phoneHmac: input.phoneHmac,
      country: input.country,
      success: false,
      error: errorCode,
    });
  } catch {
    logger.error({ purpose: input.purpose }, "failed to write SMS audit log");
  }
}

async function releaseReservation(
  totalKey: string,
  laneKey: string,
  reservationKey: string,
): Promise<void> {
  try {
    await redis.eval(RELEASE_SCRIPT, 3, totalKey, laneKey, reservationKey);
  } catch {
    logger.error("failed to release SMS budget reservation");
  }
}

async function commitReservation(reservationKey: string): Promise<void> {
  try {
    await redis.del(reservationKey);
  } catch {
    // Keep both counters spent if Redis is unavailable; they expire at UTC rollover.
    logger.error("failed to finalize SMS budget reservation");
  }
}

async function updateSmsLog(
  id: string,
  update: {
    providerMsgId: string | null;
    success: boolean;
    error: string | null;
    priceEur: string | null;
  },
  purpose: SmsPurpose,
): Promise<void> {
  try {
    await db.update(smsLog).set(update).where(eq(smsLog.id, id));
  } catch {
    logger.error({ purpose }, "failed to update SMS audit log");
  }
}

async function sendWithSeven(
  input: SmsInput,
  foreignId: string,
): Promise<ProviderResult> {
  let response: SevenSmsResponse;
  try {
    response = await fetchJson<SevenSmsResponse>(
      "https://gateway.seven.io/api/sms",
      {
        method: "POST",
        headers: { "X-Api-Key": config.SEVEN_API_KEY },
        body: {
          to: input.toE164,
          text: input.text,
          from: config.SEVEN_SENDER || undefined,
          foreign_id: foreignId,
        },
        timeoutMs: 10_000,
      },
    );
  } catch {
    // A timeout or connection reset may follow provider acceptance.
    throw new Error("provider_outcome_unknown");
  }

  const classification = classifySevenResponse(response);
  if (classification.kind === "unknown")
    throw new Error("provider_outcome_unknown");
  if (classification.kind === "rejected") {
    throw new SmsProviderRejected(
      classification.code,
      classification.priceEur,
    );
  }
  return classification.result;
}

export async function sendSms(
  input: SmsInput,
  options: SmsOptions = {},
): Promise<{
  ok: true;
  outcome: "sent";
  providerMsgId: string | null;
}> {
  if (!config.SMS_ENABLED) {
    await writeRejectedAttempt(input, "disabled");
    throw new SmsDeliveryError("disabled");
  }

  const day = utcDayKey();
  const budgetLane = inputLane(input);
  const totalKey = counterKey(day);
  const laneKey = laneCounterKey(budgetLane, day);
  const warningKey = `sms:warned:${day}`;
  const reservationKey = `sms:reservation:${randomUUID()}`;
  const threshold = Math.ceil(config.SMS_DAILY_CAP * 0.8);

  let reservation: unknown;
  try {
    reservation = await redis.eval(
      RESERVE_SCRIPT,
      5,
      totalKey,
      laneKey,
      KILL_SWITCH_KEY,
      reservationKey,
      warningKey,
      String(config.SMS_DAILY_CAP),
      String(laneLimit[budgetLane]),
      String(COUNTER_TTL_SEC),
      String(threshold),
    );
  } catch {
    await writeRejectedAttempt(input, "redis_unavailable");
    throw new SmsDeliveryError("deferred_budget", PRE_PROVIDER_RETRY_MS);
  }

  if (!Array.isArray(reservation) || reservation.length < 2) {
    await writeRejectedAttempt(input, "reservation_failed");
    throw new SmsDeliveryError("deferred_budget", PRE_PROVIDER_RETRY_MS);
  }
  const status = Number(reservation[0]);
  const warned = Number(reservation[1]);
  if (!Number.isSafeInteger(status) || !Number.isSafeInteger(warned)) {
    await writeRejectedAttempt(input, "reservation_failed");
    throw new SmsDeliveryError("deferred_budget", PRE_PROVIDER_RETRY_MS);
  }
  if (status === -1) {
    await writeRejectedAttempt(input, "disabled");
    throw new SmsDeliveryError("disabled", PRE_PROVIDER_RETRY_MS);
  }
  if (status === 0) {
    await writeRejectedAttempt(input, "daily_budget");
    throw new SmsDeliveryError("deferred_budget", millisUntilUtcRollover());
  }
  if (status < 0) {
    await writeRejectedAttempt(input, "reservation_failed");
    throw new SmsDeliveryError("deferred_budget", PRE_PROVIDER_RETRY_MS);
  }

  if (warned === 1) {
    logger.warn(
      { sentToday: status, dailyCap: config.SMS_DAILY_CAP },
      "SMS daily cap reached 80%",
    );
  }

  if (config.SMS_DRIVER === "log" && config.NODE_ENV !== "development") {
    await releaseReservation(totalKey, laneKey, reservationKey);
    await writeRejectedAttempt(input, "log_driver_disabled");
    throw new SmsDeliveryError("disabled", PRE_PROVIDER_RETRY_MS);
  }

  if (options.beforeProvider) {
    try {
      await options.beforeProvider();
    } catch (error) {
      await releaseReservation(totalKey, laneKey, reservationKey);
      if (error instanceof SmsDeliveryError) {
        await writeRejectedAttempt(input, error.outcome);
        throw error;
      }
      const retryAfterSec =
        error instanceof AppError &&
        error.code === "RATE_LIMITED" &&
        typeof error.details?.retryAfterSec === "number"
          ? error.details.retryAfterSec
          : null;
      const outcome =
        error instanceof AppError && error.code === "RATE_LIMITED"
          ? "deferred_rate_limit"
          : "deferred_budget";
      await writeRejectedAttempt(input, outcome);
      throw new SmsDeliveryError(
        outcome,
        retryAfterSec === null
          ? PRE_PROVIDER_RETRY_MS
          : Math.max(1_000, retryAfterSec * 1_000),
      );
    }
  }

  let logId: string;
  try {
    const [row] = await db
      .insert(smsLog)
      .values({
        purpose: input.purpose,
        phoneHmac: input.phoneHmac,
        country: input.country,
        success: false,
      })
      .returning({ id: smsLog.id });
    if (!row) throw new Error("SMS log insert returned no row");
    logId = row.id;
  } catch {
    await releaseReservation(totalKey, laneKey, reservationKey);
    logger.error({ purpose: input.purpose }, "failed to create SMS audit log");
    throw new SmsDeliveryError("deferred_budget", PRE_PROVIDER_RETRY_MS);
  }

  try {
    let result: ProviderResult;
    if (config.SMS_DRIVER === "log") {
      // This development-only log line is the sole permitted raw-number log.
      logger.warn(
        { purpose: input.purpose, country: input.country },
        `[DEV SMS] to ${input.toE164}: ${input.text}`,
      );
      result = { providerMsgId: null, priceEur: null };
    } else {
      result = await (options.provider ?? sendWithSeven)(input, logId);
    }

    await commitReservation(reservationKey);
    await updateSmsLog(
      logId,
      {
        providerMsgId: result.providerMsgId,
        success: true,
        error: null,
        priceEur: result.priceEur,
      },
      input.purpose,
    );
    return { ok: true, outcome: "sent", providerMsgId: result.providerMsgId };
  } catch (error) {
    if (error instanceof SmsProviderRejected) {
      await releaseReservation(totalKey, laneKey, reservationKey);
      await updateSmsLog(
        logId,
        {
          providerMsgId: null,
          success: false,
          error: error.providerCode,
          priceEur: error.priceEur,
        },
        input.purpose,
      );
      throw new SmsDeliveryError("provider_rejected");
    }

    // Once provider invocation starts, failure is ambiguous. Keep the slots spent and block blind resend.
    await commitReservation(reservationKey);
    await updateSmsLog(
      logId,
      {
        providerMsgId: null,
        success: false,
        error: "provider_unknown",
        priceEur: null,
      },
      input.purpose,
    );
    throw new SmsDeliveryError("provider_unknown");
  }
}

export async function smsAvailable(
  lane: SmsBudgetLane = "onboarding",
): Promise<boolean> {
  if (!config.SMS_ENABLED) return false;
  try {
    const available = await redis.eval(
      AVAILABLE_SCRIPT,
      3,
      counterKey(),
      laneCounterKey(lane),
      KILL_SWITCH_KEY,
      String(config.SMS_DAILY_CAP),
      String(laneLimit[lane]),
    );
    return Number(available) === 1;
  } catch {
    return false;
  }
}

export async function smsSentToday(): Promise<number> {
  const count = await redis.get(counterKey());
  if (!count) return 0;
  const parsed = Number(count);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function setSmsKillSwitch(on: boolean): Promise<void> {
  if (on) {
    await redis.set(KILL_SWITCH_KEY, "1");
  } else {
    await redis.del(KILL_SWITCH_KEY);
  }
}

export async function sevenBalance(): Promise<number | null> {
  if (!config.SEVEN_API_KEY) return null;
  try {
    const response = await fetchJson<number | { amount?: number | string }>(
      "https://gateway.seven.io/api/balance",
      {
        headers: { "X-Api-Key": config.SEVEN_API_KEY },
        timeoutMs: 10_000,
      },
    );
    const amount = typeof response === "number" ? response : response?.amount;
    if (typeof amount !== "number" && typeof amount !== "string") return null;
    const parsed = Number(amount);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}
