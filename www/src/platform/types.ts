export type PlatformErrorCode = "cancelled" | "not_available" | "permission_denied" | "failed";

export class PlatformError extends Error {
  constructor(
    public readonly code: PlatformErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

export type PlatformOS = "web" | "android" | "ios";
export type BiometricKind = "none" | "fingerprint" | "face" | "iris";
export type Unsubscribe = () => Promise<void>;
export type ShareContent = { title?: string; text?: string; url?: string };
// data is UTF-8 text or a Blob (not an ambiguous raw base64 string).
export type ShareFile = { filename: string; mime: string; data: string | Blob };
export type ContactPhone = { name: string; phones: { label?: string; number: string }[] };

export interface Platform {
  readonly isNative: boolean;
  readonly os: PlatformOS;
  openExternal(url: string): Promise<void>;
  minimizeApp(): Promise<void>;
  configureSystemUI(): Promise<Unsubscribe>;
  share(content: ShareContent): Promise<void>;
  canShare(): Promise<boolean>;
  copyText(text: string): Promise<void>;
  persistentStorage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  secureStorage: Platform["persistentStorage"] & { clear(): Promise<void> };
  biometric: {
    isAvailable(): Promise<{ available: boolean; deviceSecure: boolean; kind: BiometricKind }>;
    authenticate(reason: string): Promise<void>;
  };
  pickContactPhone(): Promise<ContactPhone | null>;
  onBackButton(handler: (event: { canGoBack: boolean }) => void): Promise<Unsubscribe>;
  onResume(handler: () => void): Promise<Unsubscribe>;
  onPause(handler: () => void): Promise<Unsubscribe>;
  onAppUrlOpen(handler: (event: { url: string }) => void): Promise<Unsubscribe>;
  saveAndShareFile(file: ShareFile): Promise<void>;
}

// Never expose raw plugin messages: storage errors can contain sensitive data.
export function platformError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const message = String((error as { message?: unknown } | null)?.message ?? "");
  if (/cancel|userFallback|AbortError/i.test(code + message)) {
    return new PlatformError("cancelled", "The action was cancelled.");
  }
  if (/permission|denied|NotAllowed/i.test(code + message)) {
    return new PlatformError("permission_denied", "Permission was denied.");
  }
  if (
    /unavailable|notAvailable|notEnrolled|passcodeNotSet|noDeviceCredential|unimplemented|not supported/i.test(
      code + message,
    )
  ) {
    return new PlatformError("not_available", "This feature is not available.");
  }
  return new PlatformError("failed", "The device action failed. Please try again.");
}

export async function deviceAction<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw platformError(error);
  }
}

export function externalUrl(url: string): string {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new PlatformError("failed", "This link cannot be opened.");
  }
  return parsed.href;
}
