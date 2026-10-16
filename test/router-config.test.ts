import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:7432/test',
  POSTGRES_PASSWORD: 'test-only',
  REDIS_URL: 'redis://127.0.0.1:7379/0',
  CHAIN: 'robinhood-testnet',
  PUBLIC_RPC_URL: '',
  PHONE_HMAC_SECRET: 'a'.repeat(64),
  PHONE_ENC_KEY: 'b'.repeat(64),
  IP_HASH_SALT: 'audit-signer-test',
  APP_URL: 'http://localhost:7400',
  RPC_RELAY_ISOLATION_REQUIRED: 'false',
  CLIENT_RPC_URLS: '',
  TRUSTED_PROXY_IPS: '',
  ROUTER_ENABLED: 'true',
  ROUTER_ADDRESS: '0x0000000000000000000000000000000000000001',
  ROUTER_NEW_AUTHORIZATIONS_ENABLED: 'false',
  ROUTER_NEW_CLAIM_SIGNATURES_ENABLED: 'false',
  ROUTER_RELAY_BROADCASTS_ENABLED: 'false',
  ROUTER_SIGNER_KEY: '',
  RELAYER_PRIVATE_KEY: '',
};

function parseConfig(overrides: Record<string, string> = {}) {
  const script = "import { config, rpcSettings } from './src/config.ts'; process.stdout.write(JSON.stringify({ routerEnabled: config.ROUTER_ENABLED, address: config.ROUTER_ADDRESS, hasSignerKey: Object.hasOwn(config, 'ROUTER_SIGNER_KEY'), hasRelayerKey: Object.hasOwn(config, 'RELAYER_PRIVATE_KEY'), isolationRequired: rpcSettings.isolationRequired, clientUrlCount: rpcSettings.clientUrls.length, clientUrlsPublic: Object.hasOwn(config, 'CLIENT_RPC_URLS'), trustedProxyIps: config.TRUSTED_PROXY_IPS }));";
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
      isolationRequired: false,
      clientUrlCount: 0,
      clientUrlsPublic: false,
      trustedProxyIps: [],
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

  it('rejects authorization lifetimes beyond the application signing policy', () => {
    const result = parseConfig({ ROUTER_AUTH_TTL_SECONDS: '601' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ROUTER_AUTH_TTL_SECONDS');
  });
});

describe('RPC isolation and trusted proxy configuration', () => {
  it('accepts explicit disjoint client URLs and canonicalizes trusted peer addresses without exporting endpoints', () => {
    const result = parseConfig({
      RPC_RELAY_ISOLATION_REQUIRED: 'true',
      CLIENT_RPC_URLS: 'https://rpc-client.example/project-a,https://rpc-client-2.example/project-b',
      TRUSTED_PROXY_IPS: '127.0.0.1,2001:0db8:0:0:0:0:0:2',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      isolationRequired: true, clientUrlCount: 2, clientUrlsPublic: false,
      trustedProxyIps: ['127.0.0.1', '2001:db8::2'],
    });
  });

  it('fails closed when strict isolation has no client endpoint', () => {
    const result = parseConfig({ RPC_RELAY_ISOLATION_REQUIRED: 'true' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CLIENT_RPC_URLS');
  });

  it('allows keyless recovery boot when relay is disabled even if strict isolation remains required', () => {
    const result = parseConfig({ RPC_RELAY_ENABLED: 'false', RPC_RELAY_ISOLATION_REQUIRED: 'true' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      isolationRequired: true,
      clientUrlCount: 0,
      routerEnabled: true,
      hasSignerKey: false,
      hasRelayerKey: false,
    });
  });

  it('rejects a client endpoint on a worker RPC origin in strict isolation mode', () => {
    const result = parseConfig({
      RPC_RELAY_ISOLATION_REQUIRED: 'true',
      CLIENT_RPC_URLS: 'https://rpc.testnet.chain.robinhood.com',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CLIENT_RPC_URLS');
  });

  it('allows a separate provider project path on the same host without claiming quota independence', () => {
    const result = parseConfig({
      RPC_RELAY_ISOLATION_REQUIRED: 'true',
      CLIENT_RPC_URLS: 'https://rpc.testnet.chain.robinhood.com/client-project',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).isolationRequired).toBe(true);
  });

  it('rejects invalid proxy literals and non-HTTP(S) client endpoints', () => {
    const badProxy = parseConfig({ TRUSTED_PROXY_IPS: '127.0.0.1/8' });
    expect(badProxy.status).not.toBe(0);
    expect(badProxy.stderr).toContain('TRUSTED_PROXY_IPS');
    const badRpc = parseConfig({ CLIENT_RPC_URLS: 'file:///etc/passwd' });
    expect(badRpc.status).not.toBe(0);
    expect(badRpc.stderr).toContain('CLIENT_RPC_URLS');
  });
});
