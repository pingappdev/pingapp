import type { QueryClient } from "@tanstack/react-query";
import { signMessage } from "wagmi/actions";
import { api, endpoints, onNativeUnauthenticated, setNativeTokenProvider } from "../api/client";
import { qk, transitionSession } from "../api/hooks";
import type { Me } from "../api/types";
import { platform } from "../platform";
import { keyManager } from "../wallet/native/keyManager";
import { ProviderError, setApprovalHandler } from "../wallet/native/provider";
import { consumeTrustedSiwe, signAppSiwe } from "../wallet/native/siweApproval";
import { connectNativeWallet, nativeWagmiConfig } from "../wallet/native/wagmi";

const TOKEN_KEY = "pingapp.session.v1";
const SIGNED_OUT_KEY = "pingapp.session.signed-out.v1";
let token: string | null | undefined;
let tokenLoad: Promise<string | null> | undefined;
let signInFlight: Promise<Me> | undefined;
let startupFlight: Promise<Me | null> | undefined;
let epoch = 0;
let suspended = false;
const clients = new Set<QueryClient>();

// MOB-08 replaces this handler with its lock/biometric policy and consumes the
// same one-shot SIWE permits. Other signatures fail closed in this interim.
setApprovalHandler(async (request) => {
  if (!consumeTrustedSiwe(request))
    throw new ProviderError(4100, "Unlock and approve this action before signing.");
});

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
  const expectedEpoch = epoch;
  signInFlight = (async () => {
    if (
      suspended ||
      (await platform.secureStorage.get(SIGNED_OUT_KEY)) ||
      (await keyManager.backupRequired()) ||
      keyManager.getState() !== "unlocked"
    )
      throw new Error("Continue wallet sign-in to open your workspace.");
    const address = await keyManager.address();
    if (!address) throw new Error("Create or import a wallet first.");
    await connectNativeWallet();
    const { nonce } = await endpoints.auth.nonce();
    const { message, signature } = await signAppSiwe("login", nonce, address, (message) =>
      signMessage(nativeWagmiConfig, { message }),
    );
    const result = await api<{ me: Me; token: string }>("/v1/auth/verify", {
      method: "POST",
      body: { message, signature, client: "native" },
    });
    if (expectedEpoch !== epoch || suspended || keyManager.getState() !== "unlocked")
      throw new Error("Wallet sign-in was cancelled.");
    if (!/^[A-Za-z0-9_-]{43}$/.test(result.token))
      throw new Error("PingApp could not create a device session. Try again.");
    if (result.me.address.toLowerCase() !== address.toLowerCase())
      throw new Error("The device session belongs to another wallet. Try again.");
    await platform.secureStorage.set(TOKEN_KEY, result.token);
    if (expectedEpoch !== epoch || suspended) {
      await platform.secureStorage.remove(TOKEN_KEY);
      throw new Error("Wallet sign-in was cancelled.");
    }
    token = result.token;
    await publish(result.me);
    return result.me;
  })().finally(() => {
    signInFlight = undefined;
  });
  return signInFlight;
}

export async function resumeNativeSession(): Promise<Me> {
  suspended = false;
  await platform.secureStorage.remove(SIGNED_OUT_KEY);
  await keyManager.unlock();
  return signInSilently();
}

export async function signOutNative(): Promise<void> {
  // This intent survives a restart and prevents refetch/cold-start auto-login.
  suspended = true;
  epoch++;
  keyManager.lock();
  try {
    // A pre-logout storage read may be invalidated by the epoch above. Resolve
    // its persisted token explicitly so that logout still revokes that row.
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
  startupFlight = (async () => {
    if (
      suspended ||
      (await platform.secureStorage.get(SIGNED_OUT_KEY)) ||
      !(await keyManager.hasWallet()) ||
      (await keyManager.backupRequired())
    )
      return null;
    if (keyManager.getState() !== "unlocked") await keyManager.unlock();
    await connectNativeWallet();
    if (!(await getToken())) {
      try {
        return await signInSilently();
      } catch {
        return null;
      }
    }
    return (await endpoints.auth.session()).me;
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
