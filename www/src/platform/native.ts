import { Capacitor, registerPlugin } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { StatusBar, Style } from "@capacitor/status-bar";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Clipboard } from "@capacitor/clipboard";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Preferences } from "@capacitor/preferences";
import { Share } from "@capacitor/share";
import { KeychainAccess, SecureStorage } from "@aparajita/capacitor-secure-storage";
import {
  AndroidBiometryStrength,
  BiometricAuth,
  BiometryType,
} from "@aparajita/capacitor-biometric-auth";
import { Contacts } from "@capacitor-community/contacts";
import {
  deviceAction,
  externalUrl,
  platformError,
  PlatformError,
  type BiometricKind,
  type Platform,
  type PlatformOS,
} from "./types";

const kinds: Record<BiometryType, BiometricKind> = {
  [BiometryType.none]: "none",
  [BiometryType.touchId]: "fingerprint",
  [BiometryType.faceId]: "face",
  [BiometryType.fingerprintAuthentication]: "fingerprint",
  [BiometryType.faceAuthentication]: "face",
  [BiometryType.irisAuthentication]: "iris",
};

const DeviceSettings = registerPlugin<{
  openAppSettings(): Promise<void>;
  openSecuritySettings(): Promise<void>;
}>("DeviceSettings");

const SecurityLifecycle = registerPlugin<{
  clearCopiedText(options: { expected: string }): Promise<void>;
  addListener(event: "pause" | "resume", handler: () => void): Promise<{ remove(): Promise<void> }>;
}>("SecurityLifecycle");

export async function createNativePlatform(os: PlatformOS): Promise<Platform> {
  if (!Capacitor.isNativePlatform()) {
    throw new PlatformError("not_available", "The native bridge is not available.");
  }
  await deviceAction(async () => {
    await SecureStorage.setKeyPrefix("pingapp_");
    await SecureStorage.setSynchronize(false);
    await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenPasscodeSetThisDeviceOnly);
  });
  return {
    isNative: true,
    os,
    openAppSettings: () => deviceAction(() => DeviceSettings.openAppSettings()),
    openSecuritySettings: () => deviceAction(() => DeviceSettings.openSecuritySettings()),
    minimizeApp: () => deviceAction(() => App.minimizeApp()),
    configureSystemUI: () =>
      deviceAction(async () => {
        await StatusBar.setStyle({ style: Style.Dark });
        // Capacitor's Android edge-to-edge inset handling keeps content outside
        // system bars on Android 15+. Older Android/iOS use a non-overlay bar.
        await StatusBar.setOverlaysWebView({ overlay: false });
        await StatusBar.setBackgroundColor({ color: "#08080C" });
        const root = document.documentElement;
        root.classList.add("ping-native");
        const revealInput = () => {
          const input = document.activeElement;
          if (
            input instanceof HTMLElement &&
            input.matches("input,textarea,[contenteditable=true]")
          )
            input.scrollIntoView({ block: "center", behavior: "smooth" });
        };
        const shown = await Keyboard.addListener("keyboardDidShow", () => {
          root.classList.add("keyboard-open");
          revealInput();
        });
        const hidden = await Keyboard.addListener("keyboardDidHide", () =>
          root.classList.remove("keyboard-open"),
        );
        document.addEventListener("focusin", revealInput);
        return async () => {
          document.removeEventListener("focusin", revealInput);
          root.classList.remove("keyboard-open", "ping-native");
          await shown.remove();
          await hidden.remove();
        };
      }),
    openExternal: (url) => deviceAction(() => Browser.open({ url: externalUrl(url) })),
    share: (content) =>
      deviceAction(async () => {
        await Share.share(content);
      }),
    canShare: () => deviceAction(async () => (await Share.canShare()).value),
    copyText: (text) => deviceAction(() => Clipboard.write({ string: text })),
    clearCopiedText: (expected) =>
      deviceAction(async () => {
        if (os === "android") return SecurityLifecycle.clearCopiedText({ expected });
        const current = await Clipboard.read();
        if (current.type === "text/plain" && current.value === expected)
          await Clipboard.write({ string: "" });
      }),
    persistentStorage: {
      get: (key) => deviceAction(async () => (await Preferences.get({ key })).value),
      set: (key, value) => deviceAction(() => Preferences.set({ key, value })),
      remove: (key) => deviceAction(() => Preferences.remove({ key })),
    },
    secureStorage: {
      get: (key) =>
        deviceAction(async () => {
          const value = await SecureStorage.get(key, false, false);
          if (value !== null && typeof value !== "string") {
            throw new PlatformError("failed", "The stored value is invalid.");
          }
          return value;
        }),
      set: (key, value) =>
        deviceAction(() =>
          SecureStorage.set(key, value, false, false, KeychainAccess.whenPasscodeSetThisDeviceOnly),
        ),
      remove: (key) =>
        deviceAction(async () => {
          await SecureStorage.remove(key, false);
        }),
      clear: () => deviceAction(() => SecureStorage.clear(false)),
    },
    biometric: {
      isAvailable: () =>
        deviceAction(async () => {
          const result = await BiometricAuth.checkBiometry();
          return {
            available: result.strongBiometryIsAvailable,
            deviceSecure: result.deviceIsSecure,
            kind: kinds[result.biometryType] ?? "none",
          };
        }),
      authenticate: async (reason) => {
        try {
          await BiometricAuth.authenticate({
            reason,
            allowDeviceCredential: true,
            androidBiometryStrength: AndroidBiometryStrength.strong,
            androidTitle: reason,
          });
        } catch (error) {
          // Only this biometric OS error may retain its OS-provided text.
          // Storage and all other plugin failures remain sanitized.
          if ((error as { code?: string })?.code === "biometryLockout")
            throw new PlatformError("failed", String((error as Error).message));
          throw platformError(error);
        }
      },
    },
    pickContactPhone: async () => {
      try {
        const { contact } = await Contacts.pickContact({
          projection: { name: true, phones: true },
        });
        if (!contact) return null;
        return {
          name:
            contact.name?.display ??
            [contact.name?.given, contact.name?.family].filter(Boolean).join(" "),
          phones: (contact.phones ?? []).flatMap((phone) =>
            phone.number
              ? [
                  {
                    number: phone.number,
                    label: phone.label ?? phone.type,
                  },
                ]
              : [],
          ),
        };
      } catch (error) {
        const typed = platformError(error);
        if (typed.code === "cancelled") return null;
        throw typed;
      }
    },
    onBackButton: (handler) =>
      deviceAction(async () => {
        const listener = await App.addListener("backButton", handler);
        return () => deviceAction(() => listener.remove());
      }),
    onResume: (handler) =>
      deviceAction(async () => {
        const listener = await (os === "android" ? SecurityLifecycle : App).addListener(
          "resume",
          handler,
        );
        return () => deviceAction(() => listener.remove());
      }),
    onPause: (handler) =>
      deviceAction(async () => {
        const listener = await (os === "android" ? SecurityLifecycle : App).addListener(
          "pause",
          handler,
        );
        return () => deviceAction(() => listener.remove());
      }),
    onAppUrlOpen: (handler) =>
      deviceAction(async () => {
        const listener = await App.addListener("appUrlOpen", handler);
        return () => deviceAction(() => listener.remove());
      }),
    saveAndShareFile: (file) =>
      deviceAction(async () => {
        if (
          !file.filename ||
          /[/\\]/.test(file.filename) ||
          file.filename.includes(String.fromCharCode(0)) ||
          /^\.{1,2}$/.test(file.filename)
        ) {
          throw new PlatformError("failed", "The filename is invalid.");
        }
        const blob =
          file.data instanceof Blob ? file.data : new Blob([file.data], { type: file.mime });
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () => reject(new PlatformError("failed", "The file could not be read."));
          reader.readAsDataURL(blob);
        });
        // Cache only, never Documents or cloud-synced storage. Unique directories
        // prevent concurrent exports from overwriting each other's attachments.
        const path = `pingapp-share/${crypto.randomUUID()}/${file.filename}`;
        await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
        const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
        try {
          await Share.share({ files: [uri] });
        } finally {
          await Filesystem.deleteFile({ path, directory: Directory.Cache });
        }
      }),
  };
}
