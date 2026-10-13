import type { ApiError } from "../../../api/client";

export function retrySeconds(error: ApiError): number | null {
  const value = error.details?.retryAfterSec;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.ceil(value)) : null;
}

export function countdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0
    ? `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`
    : `${remainingSeconds}s`;
}

export type WebOtpCredential = Credential & { code: string };
