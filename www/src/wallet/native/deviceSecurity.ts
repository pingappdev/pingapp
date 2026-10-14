import { platform, PlatformError } from "@/platform";

const OPTIONAL_LOCK_KEY = "pingapp.wallet.optional-screen-lock.v1";

// Only an explicit Android choice permits operation without device credentials.
// A failed security check or cancelled biometric prompt never enables fallback.
export async function walletSecurity() {
  const security = await platform.biometric.isAvailable();
  const optional =
    platform.os === "android" &&
    (await platform.secureStorage.get(OPTIONAL_LOCK_KEY)) === "accepted";
  return { ...security, optional, permitted: security.deviceSecure || optional };
}

export async function acceptOptionalScreenLock() {
  if (platform.os !== "android")
    throw new PlatformError("not_available", "A device screen lock is required.");
  await platform.secureStorage.set(OPTIONAL_LOCK_KEY, "accepted");
}

export async function requireScreenLock() {
  await platform.secureStorage.remove(OPTIONAL_LOCK_KEY);
}
