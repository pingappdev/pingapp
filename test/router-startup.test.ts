import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const state = vi.hoisted(() => ({
  config: {
    ROUTER_ENABLED: true,
    ROUTER_ADDRESS: '0x0000000000000000000000000000000000000003',
    ROUTER_NEW_AUTHORIZATIONS_ENABLED: false,
    ROUTER_NEW_CLAIM_SIGNATURES_ENABLED: false,
    ROUTER_RELAY_BROADCASTS_ENABLED: false,
    ROUTER_AUTH_TTL_SECONDS: 600,
  },
  getRouterSignerAddress: vi.fn((): string => '0x000000000000000000000000000000000000000a'),
  getRelayerAccount: vi.fn(() => ({ address: '0x000000000000000000000000000000000000000b' })),
  getChainId: vi.fn(async () => 46630),
  readContract: vi.fn(async ({ functionName }: { functionName: string }): Promise<unknown> =>
    functionName === 'signer' ? '0x000000000000000000000000000000000000000a' : 123n),
  routerStartupClient: undefined as unknown,
}));

vi.mock('../src/config.js', () => ({ config: state.config }));
vi.mock('../src/lib/chain.js', () => ({
  chain: { id: 46630 },
  NATIVE_TOKEN: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  normAddress: (value: string) => value.toLowerCase(),
  isAddress: (value: string) => /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value),
}));
vi.mock('../src/lib/routerKeys.js', () => ({
  getRouterSignerAddress: state.getRouterSignerAddress,
  getRelayerAccount: state.getRelayerAccount,
}));
state.routerStartupClient = { getChainId: state.getChainId, readContract: state.readContract };
vi.mock('../src/lib/viem.js', () => ({ routerStartupClient: state.routerStartupClient }));

async function loadStartup() {
  return import('../src/lib/routerStartup.js');
}

describe('router startup validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    Object.assign(state.config, {
      ROUTER_ENABLED: true,
      ROUTER_ADDRESS: '0x0000000000000000000000000000000000000003',
      ROUTER_NEW_AUTHORIZATIONS_ENABLED: false,
      ROUTER_NEW_CLAIM_SIGNATURES_ENABLED: false,
      ROUTER_RELAY_BROADCASTS_ENABLED: false,
      ROUTER_AUTH_TTL_SECONDS: 600,
    });
    delete process.env.ROUTER_SIGNER_KEY;
    state.getChainId.mockResolvedValue(46630);
    state.getRouterSignerAddress.mockReturnValue('0x000000000000000000000000000000000000000a');
    state.getRelayerAccount.mockReturnValue({ address: '0x000000000000000000000000000000000000000b' });
    state.readContract.mockImplementation(async ({ functionName }) =>
      functionName === 'signer' ? '0x000000000000000000000000000000000000000a' : 123n);
  });

  it('keeps read-only recovery mode online without loading signer or relayer keys', async () => {
    const { initializeRouter, readRouterSettings } = await loadStartup();

    await initializeRouter();

    expect(await readRouterSettings()).toEqual({ escrowFee: 123n });
    expect(state.getChainId).toHaveBeenCalledOnce();
    expect(state.readContract).toHaveBeenCalledTimes(2);
    expect(state.getRouterSignerAddress).not.toHaveBeenCalled();
    expect(state.getRelayerAccount).not.toHaveBeenCalled();
  });

  it('maps startup failures to fixed diagnostic categories without returning provider text', async () => {
    const { routerStartupFailureCategory } = await loadStartup();
    expect(routerStartupFailureCategory(new Error('Configured router RPC chain mismatch: expected 46630, received 1.')))
      .toBe('chain_mismatch');
    expect(routerStartupFailureCategory(new Error('Configured router signer does not match the deployed router signer.')))
      .toBe('signer_mismatch');
    expect(routerStartupFailureCategory(Object.assign(new Error('provider URL with secret'), { name: 'AppError', code: 'UPSTREAM_UNAVAILABLE' })))
      .toBe('rpc_unavailable');
  });

  it('blocks signing before startup verification, then permits only the verified signer', async () => {
    const key = generatePrivateKey();
    const signerAddress = privateKeyToAccount(key).address;
    process.env.ROUTER_SIGNER_KEY = key.slice(2);
    state.getRouterSignerAddress.mockReturnValue(signerAddress);
    state.config.ROUTER_NEW_AUTHORIZATIONS_ENABLED = true;
    state.readContract.mockImplementation(async ({ functionName }) =>
      functionName === 'signer' ? signerAddress : 123n);
    const startup = await loadStartup();
    const router = await import('../src/lib/router.js');
    const auth = {
      id: `0x${'12'.repeat(32)}` as const,
      sender: '0x0000000000000000000000000000000000000001' as const,
      recipient: '0x0000000000000000000000000000000000000002' as const,
      token: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const,
      amount: 1n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    };

    await expect(router.signSendAuth(auth)).rejects.toThrow('startup verification');
    await startup.initializeRouter();
    const signature = await router.signSendAuth(auth);
    expect(await recoverTypedDataAddress({
      domain: router.routerDomain,
      types: router.sendAuthTypes,
      primaryType: 'SendAuth',
      message: auth,
      signature,
    })).toBe(signerAddress);

    process.env.ROUTER_SIGNER_KEY = generatePrivateKey().slice(2);
    await expect(router.signSendAuth(auth)).rejects.toThrow('changed after startup');
  });

  it('rejects an RPC chain mismatch before reading the router or allowing signing', async () => {
    state.config.ROUTER_NEW_AUTHORIZATIONS_ENABLED = true;
    state.getChainId.mockResolvedValue(1);
    const { initializeRouter } = await loadStartup();

    await expect(initializeRouter()).rejects.toThrow('router RPC chain mismatch');
    expect(state.readContract).not.toHaveBeenCalled();
    expect(state.getRouterSignerAddress).toHaveBeenCalledOnce();
  });

  it('checks the deployed signer before enabling authorization signing', async () => {
    state.config.ROUTER_NEW_AUTHORIZATIONS_ENABLED = true;
    state.readContract.mockImplementation(async ({ functionName }) =>
      functionName === 'signer' ? '0x000000000000000000000000000000000000000c' : 123n);
    const { initializeRouter } = await loadStartup();

    await expect(initializeRouter()).rejects.toThrow('does not match');
    expect(state.getRouterSignerAddress).toHaveBeenCalledOnce();
    expect(state.getRelayerAccount).not.toHaveBeenCalled();
  });

  it('loads a relayer key only when claim signing or relay broadcasting needs it', async () => {
    state.config.ROUTER_RELAY_BROADCASTS_ENABLED = true;
    const { initializeRouter } = await loadStartup();

    await initializeRouter();

    expect(state.getRouterSignerAddress).not.toHaveBeenCalled();
    expect(state.getRelayerAccount).toHaveBeenCalledOnce();
  });

  it('rechecks the RPC and deployed signer for every explicit reinitialization', async () => {
    const key = generatePrivateKey();
    const signerAddress = privateKeyToAccount(key).address;
    process.env.ROUTER_SIGNER_KEY = key.slice(2);
    state.getRouterSignerAddress.mockReturnValue(signerAddress);
    state.config.ROUTER_NEW_AUTHORIZATIONS_ENABLED = true;
    state.readContract.mockImplementation(async ({ functionName }) =>
      functionName === 'signer' ? signerAddress : 123n);
    const { initializeRouter } = await loadStartup();

    await initializeRouter();
    await initializeRouter();

    expect(state.getChainId).toHaveBeenCalledTimes(2);
    expect(state.readContract).toHaveBeenCalledTimes(4);
  });

  it('retains the signer address captured before startup RPC awaits', async () => {
    const key = generatePrivateKey();
    const signerAddress = privateKeyToAccount(key).address;
    const changedAddress = privateKeyToAccount(generatePrivateKey()).address;
    process.env.ROUTER_SIGNER_KEY = key.slice(2);
    state.getRouterSignerAddress.mockReturnValue(signerAddress);
    state.config.ROUTER_NEW_AUTHORIZATIONS_ENABLED = true;
    state.readContract.mockImplementation(async ({ functionName }) =>
      functionName === 'signer' ? signerAddress : 123n);
    let releaseChainId!: (chainId: number) => void;
    state.getChainId.mockImplementationOnce(() => new Promise((resolve) => { releaseChainId = resolve; }));
    const { initializeRouter, assertRouterSigningReady } = await loadStartup();

    const pending = initializeRouter();
    state.getRouterSignerAddress.mockReturnValue(changedAddress);
    releaseChainId(46630);
    await pending;

    expect(assertRouterSigningReady().address).toBe(signerAddress);
  });

  it('does not reopen signing when stop occurs during pending startup verification', async () => {
    const key = generatePrivateKey();
    const signerAddress = privateKeyToAccount(key).address;
    process.env.ROUTER_SIGNER_KEY = key.slice(2);
    state.getRouterSignerAddress.mockReturnValue(signerAddress);
    state.config.ROUTER_NEW_AUTHORIZATIONS_ENABLED = true;
    state.readContract.mockImplementation(async ({ functionName }) =>
      functionName === 'signer' ? signerAddress : 123n);
    let releaseChainId!: (chainId: number) => void;
    state.getChainId.mockImplementationOnce(() => new Promise((resolve) => { releaseChainId = resolve; }));
    const { initializeRouter, stopRouterSigning, assertRouterSigningReady } = await loadStartup();

    const pending = initializeRouter();
    stopRouterSigning();
    releaseChainId(46630);
    await pending;

    expect(() => assertRouterSigningReady()).toThrow('startup verification');
  });
});
