// SECURITY: raw keys belong only here and Keystore storage; never log, cache,
// interpolate into errors, or expose through developer hooks.
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { platform, platformInfo } from "@/platform";

export type WalletState = "none" | "locked" | "unlocked";
const STORAGE_KEY = "pingapp.wallet.v1";
const CURVE_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
type StoredWallet = {
  v: 1;
  pk: Hex;
  address: Address;
  createdAt: string;
  backupRequired?: boolean;
};
let account: ReturnType<typeof privateKeyToAccount> | undefined;
let walletAddress: Address | undefined;
let state: WalletState = "none";
let epoch = 0;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

export class WalletError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message.replace(/(?:0x)?[0-9a-f]{64}/gi, "[redacted]"));
    this.name = code;
  }
}

export class WalletLocked extends WalletError {
  constructor() {
    super("WalletLocked", "Unlock your wallet to continue.");
  }
}

function publish(next: WalletState) {
  state = next;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* Subscribers cannot interrupt key cleanup. */
    }
  }
}

function run<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation).catch((error: unknown) => {
    if (error instanceof WalletError) throw error;
    // Plugin/viem errors can contain key material or nested causes. Never retain them.
    throw new WalletError(
      "WalletStorageError",
      "The device wallet could not be accessed. Please try again.",
    );
  });
  queue = result.catch(() => {});
  return result;
}

function normalizeKey(input: string): Hex {
  const key = input.trim().replace(/^0x/i, "");
  if (
    !/^[0-9a-f]{64}$/i.test(key) ||
    BigInt(`0x${key}`) === 0n ||
    BigInt(`0x${key}`) >= CURVE_ORDER
  ) {
    throw new WalletError(
      "InvalidPrivateKey",
      "Enter a valid 64-character hexadecimal private key.",
    );
  }
  return `0x${key.toLowerCase()}`;
}

async function read(): Promise<StoredWallet | null> {
  const encoded = await platform.secureStorage.get(STORAGE_KEY);
  if (encoded === null) return null;
  const value = JSON.parse(encoded) as StoredWallet;
  if (value.v !== 1 || typeof value.pk !== "string" || typeof value.createdAt !== "string") {
    throw new WalletError(
      "WalletStorageError",
      "The stored wallet is invalid. Recover it from your backup.",
    );
  }
  const pk = normalizeKey(value.pk);
  const address = privateKeyToAccount(pk).address;
  if (getAddress(value.address) !== address) {
    throw new WalletError(
      "WalletStorageError",
      "The stored wallet is invalid. Recover it from your backup.",
    );
  }
  return {
    v: 1,
    pk,
    address,
    createdAt: value.createdAt,
    backupRequired: value.backupRequired === true,
  };
}

async function store(pk: Hex, backupRequired = false): Promise<Address> {
  // Corrupt storage still counts as an existing wallet: never overwrite it.
  if ((await platform.secureStorage.get(STORAGE_KEY)) !== null) {
    throw new WalletError("WalletExists", "A wallet already exists on this device.");
  }
  const security = await platform.biometric.isAvailable();
  if (!security.deviceSecure) {
    throw new WalletError(
      "DeviceLockRequired",
      "Set a device screen lock before creating or importing a wallet.",
    );
  }
  const address = privateKeyToAccount(pk).address;
  await platform.secureStorage.set(
    STORAGE_KEY,
    JSON.stringify({ v: 1, pk, address, createdAt: new Date().toISOString(), backupRequired }),
  );
  account = undefined;
  walletAddress = address;
  publish("locked");
  return address;
}

export const keyManager = {
  getState: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  hasWallet: () =>
    run(async () => {
      const exists = (await platform.secureStorage.get(STORAGE_KEY)) !== null;
      if (exists && state === "none") publish("locked");
      if (!exists) {
        account = undefined;
        walletAddress = undefined;
        publish("none");
      }
      return exists;
    }),
  create: () =>
    run(async () => {
      const privateKey = generatePrivateKey();
      const address = await store(privateKey, true);
      return { address, privateKey };
    }),
  importKey: (input: string) => run(async () => ({ address: await store(normalizeKey(input)) })),
  backupRequired: () => run(async () => (await read())?.backupRequired === true),
  completeBackup: (expectedAddress: Address, lastFour: string) =>
    run(async () => {
      const stored = await read();
      if (
        !stored ||
        stored.address !== expectedAddress ||
        lastFour.trim().toLowerCase() !== stored.pk.slice(-4)
      )
        throw new WalletError(
          "BackupIncomplete",
          "Check the last 4 characters of your private key.",
        );
      await platform.secureStorage.set(
        STORAGE_KEY,
        JSON.stringify({ ...stored, backupRequired: false }),
      );
    }),
  unlock: () => {
    const expectedEpoch = epoch;
    return run(async () => {
      const stored = await read();
      if (!stored) throw new WalletError("WalletMissing", "Create or import a wallet first.");
      // A lock requested during a native storage read must win.
      if (epoch !== expectedEpoch) throw new WalletLocked();
      account = privateKeyToAccount(stored.pk);
      walletAddress = stored.address;
      publish("unlocked");
    });
  },
  lock() {
    epoch++;
    account = undefined;
    publish(state === "none" ? "none" : "locked");
  },
  // Only the provider consumes the account; never pass it to UI or debug hooks.
  getAccount() {
    if (!account || state !== "unlocked") throw new WalletLocked();
    return account;
  },
  getEpoch: () => epoch,
  cancelPendingOperations() {
    epoch++;
  },
  revealPrivateKey: () => {
    const expectedEpoch = epoch;
    return run(async () => {
      if (state !== "unlocked" || epoch !== expectedEpoch) throw new WalletLocked();
      const stored = await read();
      if (!stored) throw new WalletError("WalletMissing", "There is no wallet on this device.");
      if (state !== "unlocked" || epoch !== expectedEpoch) throw new WalletLocked();
      return stored.pk;
    });
  },
  wipe() {
    this.lock();
    return run(async () => {
      await platform.secureStorage.remove(STORAGE_KEY);
      walletAddress = undefined;
      publish("none");
    });
  },
  address: () =>
    run(async () => {
      if (walletAddress) return walletAddress;
      const stored = await read();
      walletAddress = stored?.address;
      if (stored && state === "none") publish("locked");
      return walletAddress ?? null;
    }),
};

const debugBridge =
  typeof window !== "undefined" &&
  !!(window as unknown as { Capacitor?: { DEBUG?: boolean } }).Capacitor?.DEBUG;
if (
  typeof window !== "undefined" &&
  (import.meta.env.DEV || (platformInfo.isNative && debugBridge))
) {
  Object.defineProperty(window, "__pingappWallet", {
    configurable: true,
    value: Object.freeze({
      get state() {
        return keyManager.getState();
      },
      get address() {
        return walletAddress ?? null;
      },
    }),
  });
}
