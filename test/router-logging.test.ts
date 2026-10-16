import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const secret = 'aud06-synthetic-secret-value';
const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:7432/test',
  POSTGRES_PASSWORD: 'test-only',
  REDIS_URL: 'redis://127.0.0.1:7379/0',
  PHONE_HMAC_SECRET: 'a'.repeat(64),
  PHONE_ENC_KEY: 'b'.repeat(64),
  IP_HASH_SALT: 'audit-signer-test',
  APP_URL: 'http://localhost:7400',
  ROUTER_ENABLED: 'false',
  LOG_LEVEL: 'info',
};

describe('router key log protection', () => {
  it('redacts synthetic raw-key fields at root and nested logger paths', () => {
    const script = `import { logger } from './src/lib/logger.ts'; logger.info({ ROUTER_SIGNER_KEY: '${secret}', RELAYER_PRIVATE_KEY: '${secret}', routerSignerKey: '${secret}', relayerPrivateKey: '${secret}', nested: { ROUTER_SIGNER_KEY: '${secret}', RELAYER_PRIVATE_KEY: '${secret}', privateKey: '${secret}' } }, 'redaction probe');`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), env, encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout.match(/\[redacted\]/g)).toHaveLength(7);
  });
});
