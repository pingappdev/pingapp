import { platform, PlatformError } from "@/platform";
import { keyManager, WalletError, WalletLocked } from "./keyManager";
import { ProviderError, setApprovalHandler } from "./provider";
import { consumeTrustedSiwe } from "./siweApproval";

let foreground = true;
let lifecycle = 0;
let pausedAt = 0;
let authenticating = false;
let unlockFlight: Promise<void> | undefined;
let access: "ready" | "checking" | "blocked" = "ready";
const listeners = new Set<() => void>();
function publish(next: typeof access) {
  access = next;
  for (const listener of listeners) listener();
}
export const lockAccess = {
  getSnapshot: () => access,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

void platform
  .onPause(() => {
    foreground = false;
    lifecycle++;
    pausedAt = Date.now();
    // Every pending approval loses its key epoch, even for a short background.
    if (authenticating) keyManager.lock();
    else keyManager.cancelPendingOperations();
  })
  .catch(() => {});
void platform
  .onResume(() => {
    foreground = true;
    if (pausedAt && Date.now() - pausedAt > 60_000) keyManager.lock();
    pausedAt = 0;
    const expectedLifecycle = lifecycle;
    publish("checking");
    void platform.biometric
      .isAvailable()
      .then((security) => {
        if (!foreground || lifecycle !== expectedLifecycle) return;
        if (!security.deviceSecure) {
          keyManager.lock();
          publish("blocked");
        } else publish("ready");
      })
      .catch(() => {
        if (foreground && lifecycle === expectedLifecycle) {
          keyManager.lock();
          publish("ready");
        }
      });
  })
  .catch(() => {});

export async function authenticateWallet(reason: string, allow: () => boolean = () => true) {
  const expectedLifecycle = lifecycle;
  const expectedEpoch = keyManager.getEpoch();
  const expectedLocation = window.location.href;
  const guard = () => {
    if (
      !foreground ||
      access === "checking" ||
      lifecycle !== expectedLifecycle ||
      keyManager.getEpoch() !== expectedEpoch ||
      (reason !== "Unlock PingApp" && window.location.href !== expectedLocation) ||
      !allow()
    )
      throw new WalletLocked();
  };
  guard();
  // An approval is never shared with a different action or signing request.
  if (authenticating)
    throw new PlatformError("cancelled", "Another device approval is already open.");
  authenticating = true;
  try {
    const security = await platform.biometric.isAvailable();
    guard();
    if (!security.deviceSecure) {
      keyManager.lock();
      publish("blocked");
      throw new WalletError("DeviceLockRequired", "Set a screen lock to use PingApp.");
    }
    publish("ready");
    await platform.biometric.authenticate(reason);
    guard();
  } finally {
    authenticating = false;
  }
}

export function unlockWallet(allow: () => boolean = () => true): Promise<void> {
  if (keyManager.getState() === "unlocked") {
    if (!foreground || !allow()) return Promise.reject(new WalletLocked());
    return Promise.resolve();
  }
  if (unlockFlight)
    return unlockFlight.then(() => {
      if (!foreground || !allow() || keyManager.getState() !== "unlocked") throw new WalletLocked();
    });
  const expectedEpoch = keyManager.getEpoch();
  const expectedLifecycle = lifecycle;
  const valid = () =>
    foreground &&
    lifecycle === expectedLifecycle &&
    keyManager.getEpoch() === expectedEpoch &&
    allow();
  unlockFlight = (async () => {
    await authenticateWallet("Unlock PingApp", valid);
    if (!valid()) throw new WalletLocked();
    await keyManager.unlock();
    if (!valid()) throw new WalletLocked();
  })().finally(() => {
    unlockFlight = undefined;
  });
  return unlockFlight;
}

setApprovalHandler(async (request) => {
  if (consumeTrustedSiwe(request)) return;
  try {
    await authenticateWallet(
      request.kind === "transaction" ? "Confirm sending" : "Confirm signature",
    );
  } catch (error) {
    if (error instanceof WalletError || error instanceof PlatformError)
      throw new ProviderError(4001, error.message);
    throw new ProviderError(4001, "The action was cancelled.");
  }
});
