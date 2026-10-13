import { deviceAction, externalUrl, PlatformError, type Platform } from "./types";

const unsupported = async (): Promise<never> => {
  throw new PlatformError("not_available", "NotSupported: this feature requires the native app.");
};
const noListener = async () => async () => {};

export const webPlatform: Platform = {
  isNative: false,
  os: "web",
  minimizeApp: unsupported,
  configureSystemUI: noListener,
  openExternal: (url) =>
    deviceAction(async () => {
      const popup = window.open(externalUrl(url), "_blank", "noopener,noreferrer");
      // With noopener browsers can return null even when the tab was opened.
      if (popup) popup.opener = null;
    }),
  share: (content) =>
    deviceAction(async () => {
      if (!navigator.share) return unsupported();
      await navigator.share(content);
    }),
  canShare: async () => typeof navigator !== "undefined" && typeof navigator.share === "function",
  copyText: (text) =>
    deviceAction(async () => {
      if (!navigator.clipboard) return unsupported();
      await navigator.clipboard.writeText(text);
    }),
  persistentStorage: {
    get: (key) => deviceAction(async () => localStorage.getItem(key)),
    set: (key, value) => deviceAction(async () => localStorage.setItem(key, value)),
    remove: (key) => deviceAction(async () => localStorage.removeItem(key)),
  },
  secureStorage: { get: unsupported, set: unsupported, remove: unsupported, clear: unsupported },
  biometric: { isAvailable: unsupported, authenticate: unsupported },
  pickContactPhone: unsupported,
  onBackButton: noListener,
  onResume: noListener,
  onPause: noListener,
  onAppUrlOpen: noListener,
  saveAndShareFile: (file) =>
    deviceAction(async () => {
      const blob =
        file.data instanceof Blob ? file.data : new Blob([file.data], { type: file.mime });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }),
};
