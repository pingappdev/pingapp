import { parsePhoneNumberFromString } from "libphonenumber-js";
import { toast } from "sonner";
import type { Intent, Token } from "../../../api/types";

export function tokenChoices(tokens: Token[]): Token[] {
  return tokens
    .filter((token) => token.kind === "native" || token.kind === "stable" || token.kind === "stock")
    .sort((left, right) => {
      const rank = (token: Token) =>
        token.kind === "native"
          ? 0
          : token.symbol.toUpperCase() === "USDG"
            ? 1
            : token.kind === "stable"
              ? 2
              : 3;
      return rank(left) - rank(right) || left.symbol.localeCompare(right.symbol);
    });
}

export function validPhone(value: string): boolean {
  try {
    return value.startsWith("+") && (parsePhoneNumberFromString(value)?.isValid() ?? false);
  } catch {
    return false;
  }
}

export function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function daysUntil(value: string): number {
  const difference = Date.parse(value) - Date.now();
  return Number.isFinite(difference) ? Math.max(0, Math.ceil(difference / 86_400_000)) : 0;
}

export function smsCopy(status: Intent["smsStatus"]): string {
  if (status === "sent") return "Invite sent by SMS.";
  if (status === "skipped_rate_limit")
    return "This number was texted recently, so we didn't send another SMS. Share the invite link yourself.";
  return "We couldn't send the SMS. Share the invite link yourself.";
}

export async function copyInvite(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success("Invite link copied");
  } catch {
    toast.error("Could not copy. Open the invite link in a new tab, then copy its URL.");
  }
}

export async function shareInvite(intent: Intent) {
  if (typeof navigator.share !== "function") return;
  try {
    await navigator.share({
      title: "PingApp invite",
      text: "A pending send is waiting for you on PingApp.",
      url: intent.claimUrl,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return;
    toast.error("Could not share the invite link.");
  }
}
