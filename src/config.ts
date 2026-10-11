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
  ROUTER_ENABLED: boolean(false),
  ROUTER_ADDRESS: z.union([z.string().regex(/^0x[0-9a-f]{40}$/i).refine((value) => !/^0x0{40}$/i.test(value)), z.literal('')]).default(''),
  ROUTER_DEPLOY_BLOCK: z.coerce.number().int().nonnegative().default(0),
  ROUTER_SIGNER_KEY: z.union([hexKey, z.literal('')]).default(''),
  RELAYER_PRIVATE_KEY: z.union([hexKey, z.literal('')]).default(''),
  ESCROW_CLAIM_TIP_WEI: z.string().regex(/^\d+$/).default('20000000000000')
    .refine((value) => BigInt(value) <= 1000000000000000n, 'must not exceed 0.001 ETH'),
  ROUTER_AUTH_TTL_SECONDS: positiveInt(600),
  ADMIN_TOKEN: z.string().default(''),
  CARDS_ENABLED: boolean(false),
  IZIPAY_API_KEY: z.string().default(''),
  IZIPAY_API_SECRET: z.string().default(''),
  IZIPAY_WEBHOOK_SECRET: z.string().default(''),
  CARD_DATA_ENC_KEY: z.union([hexKey, z.literal('')]).default(''),
  IZIPAY_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  IZIPAY_ACCOUNT_REF: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default('primary'),
}).superRefine((value, context) => {
  if (value.ROUTER_ENABLED) {
    for (const field of ['ROUTER_ADDRESS', 'ROUTER_SIGNER_KEY', 'RELAYER_PRIVATE_KEY'] as const) {
      if (!value[field]) context.addIssue({ code: 'custom', path: [field], message: 'required when ROUTER_ENABLED=true' });
    }
    if (value.INTENT_TTL_DAYS > 60) {
      context.addIssue({ code: 'custom', path: ['INTENT_TTL_DAYS'], message: 'router escrow duration must be at most 60 days' });
    }
  }
  if (value.IZIPAY_API_KEY && !value.IZIPAY_API_KEY.startsWith(
    value.IZIPAY_MODE === 'sandbox' ? 'izpk_test_' : 'izpk_live_',
  )) {
    context.addIssue({ code: 'custom', path: ['IZIPAY_API_KEY'], message: 'key must match IZIPAY_MODE' });
  }
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
