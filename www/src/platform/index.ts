import { useEffect, useState } from "react";
import { isNativeBuild } from "@/env";
import { webPlatform } from "./web";
import type { Platform, PlatformOS } from "./types";
import { deviceAction } from "./types";

export { PlatformError } from "./types";
export type { Platform, PlatformErrorCode, ShareFile, ContactPhone, Unsubscribe } from "./types";

// Capacitor injects this bridge before the client bundle. No plugin is imported
// into the website (including its SSR renderer) to detect the platform.
const bridge =
  typeof window === "undefined"
    ? undefined
    : (
        window as unknown as {
          Capacitor?: { isNativePlatform(): boolean; getPlatform(): string };
        }
      ).Capacitor;
const isNative = isNativeBuild && !!bridge?.isNativePlatform();
export const platformInfo: { isNative: boolean; os: PlatformOS } = {
  isNative,
  os: isNative && bridge?.getPlatform() === "ios" ? "ios" : isNative ? "android" : "web",
};

let implementation: Promise<Platform> | undefined;
export function getPlatform(): Promise<Platform> {
  implementation ??=
    isNativeBuild && isNative
      ? deviceAction(() =>
          import("./native").then((module) => module.createNativePlatform(platformInfo.os)),
        )
      : Promise.resolve(webPlatform);
  return implementation;
}

// Stable asynchronous facade for non-React consumers, without plugin loading
// at module evaluation. It never falls back to web storage on native failure.
export const platform: Platform = {
  ...platformInfo,
  openExternal: async (url) => (await getPlatform()).openExternal(url),
  share: async (content) => (await getPlatform()).share(content),
  canShare: async () => (await getPlatform()).canShare(),
  copyText: async (text) => (await getPlatform()).copyText(text),
  persistentStorage: {
    get: async (key) => (await getPlatform()).persistentStorage.get(key),
    set: async (key, value) => (await getPlatform()).persistentStorage.set(key, value),
    remove: async (key) => (await getPlatform()).persistentStorage.remove(key),
  },
  secureStorage: {
    get: async (key) => (await getPlatform()).secureStorage.get(key),
    set: async (key, value) => (await getPlatform()).secureStorage.set(key, value),
    remove: async (key) => (await getPlatform()).secureStorage.remove(key),
    clear: async () => (await getPlatform()).secureStorage.clear(),
  },
  biometric: {
    isAvailable: async () => (await getPlatform()).biometric.isAvailable(),
    authenticate: async (reason) => (await getPlatform()).biometric.authenticate(reason),
  },
  pickContactPhone: async () => (await getPlatform()).pickContactPhone(),
  onBackButton: async (handler) => (await getPlatform()).onBackButton(handler),
  onResume: async (handler) => (await getPlatform()).onResume(handler),
  onPause: async (handler) => (await getPlatform()).onPause(handler),
  onAppUrlOpen: async (handler) => (await getPlatform()).onAppUrlOpen(handler),
  saveAndShareFile: async (file) => (await getPlatform()).saveAndShareFile(file),
};

export function usePlatform(): Platform {
  const [value, setValue] = useState<Platform>(platform);
  useEffect(() => {
    let active = true;
    // Keep the facade on load failure, so calls still reject instead of silently
    // using insecure browser substitutes. Callers handle the typed rejection.
    void getPlatform()
      .then((loaded) => {
        if (active) setValue(loaded);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return value;
}
