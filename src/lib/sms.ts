import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { smsLog } from '../db/schema.js';
import { config } from '../config.js';
import { AppError } from './errors.js';
import { fetchJson } from './http.js';
import { logger } from './logger.js';
import { redis } from './redis.js';

export type SmsPurpose = 'otp' | 'intent' | 'admin_test';

type SmsInput = {
  toE164: string;
  text: string;
  purpose: SmsPurpose;
  phoneHmac: string;
  country: string | null;
};

type SevenSmsResponse = {
  success?: string | number;
  messages?: Array<{
    id?: string | number | null;
    error?: string | number | { code?: string | number } | null;
  }>;
  total_price?: string | number | null;
  error?: string | number | { code?: string | number } | null;
};

class SmsSendFailure extends Error {
  constructor(
    public providerCode: string,
    public definiteRejection: boolean,
    public priceEur: string | null = null,
  ) {
    super(providerCode);
    this.name = 'SmsSendFailure';
  }
}

const COUNTER_TTL_SEC = 2 * 24 * 60 * 60;
const KILL_SWITCH_KEY = 'sms:disabled';

const RESERVE_SCRIPT = `
if redis.call('GET', KEYS[2]) == '1' then
  return {-1, 0}
end

local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local cap = tonumber(ARGV[1])
if current >= cap then
  return {0, 0}
end

local reservationCreated = redis.call('SET', KEYS[3], '1', 'EX', ARGV[2], 'NX')
if not reservationCreated then
  return {-2, 0}
end

local nextCount = redis.call('INCR', KEYS[1])
if nextCount == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end

local warned = 0
if nextCount >= tonumber(ARGV[3]) then
  local firstWarning = redis.call('SET', KEYS[4], '1', 'EX', ARGV[2], 'NX')
  if firstWarning then warned = 1 end
end

return {nextCount, warned}
`;

const AVAILABLE_SCRIPT = `
if redis.call('GET', KEYS[2]) == '1' then
  return 0
end
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current >= tonumber(ARGV[1]) then
  return 0
end
return 1
`;

const RELEASE_SCRIPT = `
if redis.call('DEL', KEYS[2]) == 0 then
  return 0
end
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 1 then
  redis.call('DEL', KEYS[1])
  return 0
end
return redis.call('DECR', KEYS[1])
`;

function utcDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function counterKey(day = utcDayKey()): string {
  return `sms:count:${day}`;
}

function temporaryUnavailable(): AppError {
  return new AppError('SMS_UNAVAILABLE', 503, 'Text messages are temporarily unavailable. Please try again later.');
}

function providerUnavailable(): AppError {
  return new AppError('SMS_UNAVAILABLE', 503, 'We could not send the text message. Please check the number and try again.');
}

function asProviderCode(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const code = String(value).trim();
  return /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : null;
}

function providerErrorCode(response: SevenSmsResponse): string {
  const candidates = [response.success, response.messages?.[0]?.error, response.error];
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object') {
      const code = asProviderCode(candidate.code);
      if (code) return code;
    }
    const code = asProviderCode(candidate);
    if (code) return code;
  }
  return 'provider_rejected';
}

function priceEur(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999_999.9999) return null;
  return amount.toFixed(4);
}

async function writeRejectedAttempt(input: SmsInput, errorCode: string): Promise<void> {
  try {
    await db.insert(smsLog).values({
      purpose: input.purpose,
      phoneHmac: input.phoneHmac,
      country: input.country,
      success: false,
      error: errorCode,
    });
  } catch {
    logger.error({ purpose: input.purpose }, 'failed to write SMS audit log');
  }
}

async function releaseReservation(count: string, reservationKey: string): Promise<void> {
  try {
    await redis.eval(RELEASE_SCRIPT, 2, count, reservationKey);
  } catch {
    logger.error('failed to release SMS daily-cap reservation');
  }
}

async function commitReservation(reservationKey: string): Promise<void> {
  try {
    await redis.del(reservationKey);
  } catch {
    // Keep the count if Redis is unavailable; the reservation marker expires with it.
    logger.error('failed to finalize SMS daily-cap reservation');
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
    logger.error({ purpose }, 'failed to update SMS audit log');
  }
}

async function sendWithSeven(input: SmsInput, foreignId: string): Promise<{
  providerMsgId: string | null;
  priceEur: string | null;
}> {
  let response: SevenSmsResponse;
  try {
    response = await fetchJson<SevenSmsResponse>('https://gateway.seven.io/api/sms', {
      method: 'POST',
      headers: { 'X-Api-Key': config.SEVEN_API_KEY },
      body: {
        to: input.toE164,
        text: input.text,
        from: config.SEVEN_SENDER || undefined,
        foreign_id: foreignId,
      },
      timeoutMs: 10_000,
    });
  } catch {
    throw new SmsSendFailure('request_failed', false);
  }

  if (typeof response.success !== 'string' && typeof response.success !== 'number') {
    throw new SmsSendFailure('invalid_response', false, priceEur(response.total_price));
  }
  if (String(response.success) !== '100') {
    throw new SmsSendFailure(providerErrorCode(response), true, priceEur(response.total_price));
  }

  const messageId = response.messages?.[0]?.id;
  return {
    providerMsgId: messageId === null || messageId === undefined ? null : String(messageId),
    priceEur: priceEur(response.total_price),
  };
}

export async function sendSms(input: SmsInput): Promise<{ ok: true; providerMsgId: string | null }> {
  if (!config.SMS_ENABLED) {
    await writeRejectedAttempt(input, 'disabled');
    throw temporaryUnavailable();
  }

  const day = utcDayKey();
  const countKey = counterKey(day);
  const warningKey = `sms:warned:${day}`;
  const reservationKey = `sms:reservation:${randomUUID()}`;
  const threshold = Math.ceil(config.SMS_DAILY_CAP * 0.8);

  let reservation: unknown;
  try {
    reservation = await redis.eval(
      RESERVE_SCRIPT,
      4,
      countKey,
      KILL_SWITCH_KEY,
      reservationKey,
      warningKey,
      String(config.SMS_DAILY_CAP),
      String(COUNTER_TTL_SEC),
      String(threshold),
    );
  } catch {
    await releaseReservation(countKey, reservationKey);
    await writeRejectedAttempt(input, 'redis_unavailable');
    throw temporaryUnavailable();
  }

  if (!Array.isArray(reservation)) {
    await writeRejectedAttempt(input, 'reservation_failed');
    throw temporaryUnavailable();
  }

  const status = Number(reservation[0]);
  const warned = Number(reservation[1]);
  if (!Number.isSafeInteger(status) || !Number.isSafeInteger(warned)) {
    await releaseReservation(countKey, reservationKey);
    await writeRejectedAttempt(input, 'reservation_failed');
    throw temporaryUnavailable();
  }
  const shouldWarn = warned === 1;
  if (status === -1) {
    await writeRejectedAttempt(input, 'disabled');
    throw temporaryUnavailable();
  }
  if (status === 0) {
    await writeRejectedAttempt(input, 'daily_cap');
    throw temporaryUnavailable();
  }
  if (status < 0) {
    await writeRejectedAttempt(input, 'reservation_failed');
    throw temporaryUnavailable();
  }

  if (shouldWarn) {
    logger.warn({ sentToday: status, dailyCap: config.SMS_DAILY_CAP }, 'SMS daily cap reached 80%');
  }

  let logId: string;
  try {
    const [row] = await db.insert(smsLog).values({
      purpose: input.purpose,
      phoneHmac: input.phoneHmac,
      country: input.country,
      success: false,
    }).returning({ id: smsLog.id });
    if (!row) throw new Error('SMS log insert returned no row');
    logId = row.id;
  } catch {
    await releaseReservation(countKey, reservationKey);
    logger.error({ purpose: input.purpose }, 'failed to create SMS audit log');
    throw temporaryUnavailable();
  }

  try {
    let result: { providerMsgId: string | null; priceEur: string | null };
    if (config.SMS_DRIVER === 'log') {
      if (config.NODE_ENV !== 'development') {
        throw temporaryUnavailable();
      }
      // This development-only log line is the sole permitted raw-number log.
      logger.warn({ purpose: input.purpose, country: input.country }, `[DEV SMS] to ${input.toE164}: ${input.text}`);
      result = { providerMsgId: null, priceEur: null };
    } else {
      result = await sendWithSeven(input, logId);
    }

    await commitReservation(reservationKey);
    await updateSmsLog(logId, {
      providerMsgId: result.providerMsgId,
      success: true,
      error: null,
      priceEur: result.priceEur,
    }, input.purpose);
    return { ok: true, providerMsgId: result.providerMsgId };
  } catch (error) {
    const providerCode = error instanceof SmsSendFailure
      ? error.providerCode
      : error instanceof AppError && error.code === 'SMS_UNAVAILABLE'
        ? 'log_driver_disabled'
        : 'request_failed';
    const definitelyNotSent = error instanceof SmsSendFailure
      ? error.definiteRejection
      : config.SMS_DRIVER === 'log';
    if (definitelyNotSent) {
      await releaseReservation(countKey, reservationKey);
    } else {
      // Timeouts and malformed upstream replies may follow an accepted send; keep the slot spent.
      await commitReservation(reservationKey);
    }
    await updateSmsLog(logId, {
      providerMsgId: null,
      success: false,
      error: providerCode,
      priceEur: error instanceof SmsSendFailure ? error.priceEur : null,
    }, input.purpose);
    if (error instanceof AppError && error.code === 'SMS_UNAVAILABLE') throw error;
    throw providerUnavailable();
  }
}

export async function smsAvailable(): Promise<boolean> {
  if (!config.SMS_ENABLED) return false;
  try {
    const available = await redis.eval(
      AVAILABLE_SCRIPT,
      2,
      counterKey(),
      KILL_SWITCH_KEY,
      String(config.SMS_DAILY_CAP),
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
    await redis.set(KILL_SWITCH_KEY, '1');
  } else {
    await redis.del(KILL_SWITCH_KEY);
  }
}

export async function sevenBalance(): Promise<number | null> {
  if (!config.SEVEN_API_KEY) return null;
  try {
    const response = await fetchJson<number | { amount?: number | string }>('https://gateway.seven.io/api/balance', {
      headers: { 'X-Api-Key': config.SEVEN_API_KEY },
      timeoutMs: 10_000,
    });
    const amount = typeof response === 'number' ? response : response?.amount;
    if (typeof amount !== 'number' && typeof amount !== 'string') return null;
    const parsed = Number(amount);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}
