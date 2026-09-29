import { z } from 'zod';

const csv = z.string().default('').transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean));
const boolean = (defaultValue: boolean) => z.enum(['true', 'false']).default(String(defaultValue) as 'true' | 'false').transform((value) => value === 'true');
const positiveInt = (defaultValue: number) => z.coerce.number().int().positive().default(defaultValue);
const decimal = (defaultValue: string) => z.string().regex(/^\d+(\.\d+)?$/).default(defaultValue);
const hexKey = z.string().regex(/^[0-9a-f]{64}$/i);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  REDIS_URL: z.string().min(1),
  CHAIN: z.enum(['robinhood', 'robinhood-testnet']).default('robinhood-testnet'),
  ALCHEMY_API_KEYS: csv,
  PUBLIC_RPC_URL: z.string().default(''),
  PHONE_HMAC_SECRET: hexKey,
  PHONE_ENC_KEY: hexKey,
  IP_HASH_SALT: z.string().min(1),
  CORS_ORIGINS: csv,
  SIWE_ALLOWED_DOMAINS: csv,
  COOKIE_DOMAIN: z.string().default(''),
  COOKIE_SECURE: boolean(false),
  APP_URL: z.string().url(),
  SUPPORT_CONTACT: z.string().trim().default(''),
  SMS_DRIVER: z.enum(['log', 'seven']).default('log'),
  SMS_ENABLED: boolean(true),
  SEVEN_API_KEY: z.string().default(''),
  SEVEN_SENDER: z.string().regex(/^[A-Za-z0-9]{1,11}$/).default('PingApp'),
  SMS_DAILY_CAP: positiveInt(300),
  RECENTLY_LINKED_DAYS: positiveInt(7),
  INTENT_TTL_DAYS: positiveInt(14),
  MIN_SEND_USD: decimal('2'),
  MIN_SEND_ETH_FALLBACK: decimal('0.001'),
  ADMIN_TOKEN: z.string().default(''),
}).superRefine((value, context) => {
  if (value.SMS_DRIVER === 'seven' && !value.SEVEN_API_KEY) {
    context.addIssue({ code: 'custom', path: ['SEVEN_API_KEY'], message: 'required when SMS_DRIVER=seven' });
  }
});

const result = envSchema.safeParse(process.env);
if (!result.success) {
  const variables = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? 'environment')))];
  process.stderr.write(`Invalid backend configuration: ${variables.join(', ')}\n`);
  process.exit(1);
}

const parsed = result.data;
export const config = Object.freeze({
  ...parsed,
  PUBLIC_RPC_URL: parsed.PUBLIC_RPC_URL || (parsed.CHAIN === 'robinhood'
    ? 'https://rpc.mainnet.chain.robinhood.com'
    : 'https://rpc.testnet.chain.robinhood.com'),
});

if (config.NODE_ENV === 'production' && config.SMS_DRIVER === 'log') {
  process.stderr.write('WARNING: SMS_DRIVER=log in production; SMS messages will appear in logs.\n');
}
