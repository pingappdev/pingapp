import type { QueryClient } from "@tanstack/react-query";
import { signMessage } from "wagmi/actions";
import { api, endpoints, onNativeUnauthenticated, setNativeTokenProvider } from "../api/client";
import { qk, transitionSession } from "../api/hooks";
import type { Me } from "../api/types";
import { platform } from "../platform";
import { keyManager } from "../wallet/native/keyManager";
import { signAppSiwe } from "../wallet/native/siweApproval";
import { unlockWallet } from "../wallet/native/lockPolicy";
import { connectNativeWallet, nativeWagmiConfig } from "../wallet/native/wagmi";

const TOKEN_KEY = "pingapp.session.v1";
const SIGNED_OUT_KEY = "pingapp.session.signed-out.v1";
let token: string | null | undefined;
let tokenLoad: Promise<string | null> | undefined;
let signInFlight: Promise<Me> | undefined;
let startupFlight: Promise<Me | null> | undefined;
let epoch = 0;
let suspended = false;
let foreground = true;
let lifecycle = 0;
let logoutFlight: Promise<void> | undefined;
let resuming = 0;

export class NativeSessionCancelled extends Error {
  constructor() {
    super("Wallet sign-in was cancelled.");
  }
}

// Minimal lifecycle cancellation; MOB-08 adds its visible lock/prompt policy.
void platform
  .onPause(() => {
    foreground = false;
    lifecycle++;
    if (signInFlight || startupFlight || resuming) keyManager.lock();
  })
  .catch(() => {});
void platform
  .onResume(() => {
    foreground = true;
  })
  .catch(() => {});

function sessionGuard(allow: () => boolean = () => true) {
  const expectedEpoch = epoch;
  const expectedLifecycle = lifecycle;
  const expectedWalletEpoch = keyManager.getEpoch();
  return () => {
    if (
      !foreground ||
      lifecycle !== expectedLifecycle ||
      epoch !== expectedEpoch ||
      keyManager.getEpoch() !== expectedWalletEpoch ||
      !allow()
    )
      throw new NativeSessionCancelled();
  };
}
const clients = new Set<QueryClient>();

export async function getToken(): Promise<string | null> {
  if (token !== undefined) return token;
  const expectedEpoch = epoch;
  tokenLoad ??= platform.secureStorage
    .get(TOKEN_KEY)
    .then((stored) => {
      if (epoch === expectedEpoch) token = stored;
      return epoch === expectedEpoch ? stored : (token ?? null);
    })
    .finally(() => {
      tokenLoad = undefined;
    });
  return tokenLoad;
}

export async function clearToken(): Promise<void> {
  epoch++;
  token = null;
  await platform.secureStorage.remove(TOKEN_KEY);
}

async function publish(me: Me | null) {
  await Promise.all(
    [...clients].map(async (client) => {
      await transitionSession(client, me);
      if (me) void client.invalidateQueries({ queryKey: qk.me });
    }),
  );
}

export function signInSilently(): Promise<Me> {
  if (signInFlight) return signInFlight;
  const guard = sessionGuard();
  const assertSigning = () => {
    guard();
    if (suspended || keyManager.getState() !== "unlocked") throw new NativeSessionCancelled();
  };
  signInFlight = (async () => {
    assertSigning();
    if (
      suspended ||
      (await platform.secureStorage.get(SIGNED_OUT_KEY)) ||
      (await keyManager.backupRequired()) ||
      keyManager.getState() !== "unlocked"
    )
      throw new Error("Continue wallet sign-in to open your workspace.");
    assertSigning();
    const address = await keyManager.address();
    assertSigning();
    if (!address) throw new Error("Create or import a wallet first.");
    await connectNativeWallet();
    assertSigning();
    const { nonce } = await endpoints.auth.nonce();
    assertSigning();
    const { message, signature } = await signAppSiwe("login", nonce, address, (message) =>
      signMessage(nativeWagmiConfig, { message }),
    );
    assertSigning();
    const result = await api<{ me: Me; token: string }>("/v1/auth/verify", {
      method: "POST",
      body: { message, signature, client: "native" },
    });
    assertSigning();
    if (!/^[A-Za-z0-9_-]{43}$/.test(result.token))
      throw new Error("PingApp could not create a device session. Try again.");
    if (result.me.address.toLowerCase() !== address.toLowerCase())
      throw new Error("The device session belongs to another wallet. Try again.");
    await platform.secureStorage.set(TOKEN_KEY, result.token);
    try {
      assertSigning();
    } catch (error) {
      await platform.secureStorage.remove(TOKEN_KEY);
      throw error;
    }
    token = result.token;
    await publish(result.me);
    assertSigning();
    return result.me;
  })().finally(() => {
    signInFlight = undefined;
  });
  return signInFlight;
}

export async function resumeNativeSession(allow: () => boolean = () => true): Promise<Me> {
  resuming++;
  try {
    const guard = sessionGuard(allow);
    if (logoutFlight) {
      try {
        await logoutFlight;
      } catch {
        /* Local logout still completed. */
      }
    }
    guard();
    if (signInFlight) {
      try {
        await signInFlight;
      } catch {
        /* Cancelled prior operation. */
      }
    }
    guard();
    // Only the explicit resume may remove the persisted logout intent.
    await platform.secureStorage.remove(SIGNED_OUT_KEY);
    try {
      guard();
    } catch (error) {
      if (suspended) await platform.secureStorage.set(SIGNED_OUT_KEY, "1");
      throw error;
    }
    suspended = false;
    await unlockWallet(() => {
      guard();
      return true;
    });
    guard();
    const me = await signInSilently();
    guard();
    return me;
  } finally {
    resuming--;
  }
}

export function signOutNative(): Promise<void> {
  if (logoutFlight) return logoutFlight;
  suspended = true;
  epoch++;
  keyManager.lock();
  logoutFlight = (async () => {
    try {
      token ??= await platform.secureStorage.get(TOKEN_KEY);
      await platform.secureStorage.set(SIGNED_OUT_KEY, "1");
      if (await getToken()) await endpoints.auth.logout();
    } finally {
      keyManager.lock();
      try {
        await clearToken();
      } finally {
        await publish(null);
      }
    }
  })().finally(() => {
    logoutFlight = undefined;
  });
  return logoutFlight;
}

export async function removeNativeWallet(): Promise<void> {
  try {
    await signOutNative();
  } catch {
    // Offline removal must still remove the local key and session. Logout was
    // attempted first; an unreachable server may retain its expiring row.
  } finally {
    await keyManager.wipe();
  }
}

export function readNativeSession(client: QueryClient): Promise<Me | null> {
  clients.add(client);
  if (startupFlight) return startupFlight;
  const guard = sessionGuard();
  const assertStartup = () => {
    guard();
    if (suspended || logoutFlight) throw new NativeSessionCancelled();
  };
  startupFlight = (async () => {
    try {
      assertStartup();
      const signedOut = await platform.secureStorage.get(SIGNED_OUT_KEY);
      assertStartup();
      if (signedOut) return null;
      const exists = await keyManager.hasWallet();
      assertStartup();
      if (!exists) return null;
      const needsBackup = await keyManager.backupRequired();
      assertStartup();
      if (needsBackup) return null;
      if (keyManager.getState() !== "unlocked") {
        assertStartup();
        await unlockWallet(() => {
          assertStartup();
          return true;
        });
        assertStartup();
      }
      await connectNativeWallet();
      assertStartup();
      const current = await getToken();
      assertStartup();
      if (!current) {
        try {
          return await signInSilently();
        } catch {
          return null;
        }
      }
      const result = await endpoints.auth.session();
      assertStartup();
      return result.me;
    } catch (error) {
      if (error instanceof NativeSessionCancelled) return null;
      throw error;
    }
  })().finally(() => {
    startupFlight = undefined;
  });
  return startupFlight;
}

setNativeTokenProvider(getToken);
onNativeUnauthenticated(async (failedToken) => {
  if (suspended || (await keyManager.backupRequired()) || keyManager.getState() !== "unlocked")
    return false;
  const current = await getToken();
  if (current && current !== failedToken) return true;
  try {
    await signInSilently();
    return true;
  } catch {
    // A stale failure cannot erase a successful token rotation.
    if ((await getToken()) === failedToken) {
      suspended = true;
      keyManager.lock();
      await clearToken();
      await publish(null);
    }
    return false;
  }
});
