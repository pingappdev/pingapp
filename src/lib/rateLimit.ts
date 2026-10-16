import { RateLimiterRedis } from 'rate-limiter-flexible';
import { errors } from './errors.js';
import { redis } from './redis.js';

export function limiter(name: string, points: number, durationSec: number): RateLimiterRedis {
  return new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `rl:${name}`,
    points,
    duration: durationSec,
    rejectIfRedisNotReady: true,
  });
}

export async function consume(l: RateLimiterRedis, key: string, points = 1): Promise<void> {
  try {
    await l.consume(key, points);
  } catch (error) {
    if (error && typeof error === 'object' && 'msBeforeNext' in error &&
      typeof error.msBeforeNext === 'number') {
      throw errors.rateLimited(Math.ceil(error.msBeforeNext / 1000));
    }
    throw error;
  }
}

export async function peek(l: RateLimiterRedis, key: string): Promise<{ remaining: number; resetSec: number }> {
  const result = await l.get(key);
  return {
    remaining: result?.remainingPoints ?? l.points,
    resetSec: result ? Math.ceil(result.msBeforeNext / 1000) : 0,
  };
}

export const limits = {
  otpPhoneBurst: limiter('otp_phone_burst', 1, 60),
  otpPhoneDay: limiter('otp_phone_day', 5, 86400),
  otpUserDay: limiter('otp_user_day', 8, 86400),
  otpIpDay: limiter('otp_ip_day', 20, 86400),
  otpVerifyUserHour: limiter('otp_verify_user_h', 20, 3600),
  resolveUserMin: limiter('resolve_user_min', 30, 60),
  resolveUserDay: limiter('resolve_user_day', 300, 86400),
  resolveIpDay: limiter('resolve_ip_day', 600, 86400),
  intentUserDay: limiter('intent_user_day', 5, 86400),
  intentPhoneSmsDay: limiter('intent_phone_sms_day', 1, 86400),
  intentPhoneSms30d: limiter('intent_phone_sms_30d', 3, 30 * 86400),
  claimsIpHour: limiter('claims_ip_h', 60, 3600),
  balancesRefresh: limiter('balances_refresh', 1, 10),
  general: limiter('general', 120, 60),
  generalIp: limiter('general_ip', 600, 60),
} as const;
