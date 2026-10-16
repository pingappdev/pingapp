import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:7432/test',
  POSTGRES_PASSWORD: 'test-only',
  REDIS_URL: 'redis://127.0.0.1:7379/0',
  PHONE_HMAC_SECRET: 'a'.repeat(64),
  PHONE_ENC_KEY: 'b'.repeat(64),
  IP_HASH_SALT: 'audit-signer-test',
  APP_URL: 'http://localhost:7400',
  ROUTER_ENABLED: 'true',
  ROUTER_ADDRESS: '0x0000000000000000000000000000000000000001',
  ROUTER_NEW_AUTHORIZATIONS_ENABLED: 'false',
  ROUTER_NEW_CLAIM_SIGNATURES_ENABLED: 'false',
  ROUTER_RELAY_BROADCASTS_ENABLED: 'false',
  ROUTER_SIGNER_KEY: '',
  RELAYER_PRIVATE_KEY: '',
};

function parseConfig(overrides: Record<string, string> = {}) {
  const script = "import { config } from './src/config.ts'; process.stdout.write(JSON.stringify({ routerEnabled: config.ROUTER_ENABLED, address: config.ROUTER_ADDRESS, hasSignerKey: Object.hasOwn(config, 'ROUTER_SIGNER_KEY'), hasRelayerKey: Object.hasOwn(config, 'RELAYER_PRIVATE_KEY') }));";
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, ...baseEnv, ...overrides }, encoding: 'utf8',
  });
}

describe('router incident recovery configuration', () => {
  it('boots with the router visible and no private keys when all write operations are stopped', () => {
    const result = parseConfig();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      routerEnabled: true,
      address: baseEnv.ROUTER_ADDRESS,
      hasSignerKey: false,
      hasRelayerKey: false,
    });
  });

  it('requires the router signer when a new authorization operation is enabled', () => {
    const result = parseConfig({ ROUTER_NEW_AUTHORIZATIONS_ENABLED: 'true' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ROUTER_SIGNER_KEY');
  });

  it('requires the relayer key when relay broadcasts are enabled', () => {
    const result = parseConfig({ ROUTER_RELAY_BROADCASTS_ENABLED: 'true' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('RELAYER_PRIVATE_KEY');
  });

  it('rejects authorization lifetimes beyond the router contract window', () => {
    const result = parseConfig({ ROUTER_AUTH_TTL_SECONDS: '601' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ROUTER_AUTH_TTL_SECONDS');
  });
});
