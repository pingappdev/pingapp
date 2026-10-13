import type { CardNetwork, CardProductId, IssueCardInput, TopupCardInput } from "@/api/cards";
import { ApiError } from "@/api/client";

// No email or card details. Persist before sending so a lost response/reload can
// retry exactly the same request, including the original network and amount.
export type CardRequest =
  | { kind: "issue"; input: IssueCardInput }
  | { kind: "topup"; cardId: string; input: TopupCardInput };
const key = (userId: string) => `pingapp:card-request:${userId}`;
const networks: CardNetwork[] = ["tron", "bsc", "ethereum", "polygon"];
const products: CardProductId[] = ["visa", "mastercard_standard", "visa_us", "mastercard"];

export function readCardRequest(userId: string): CardRequest | null {
  try {
    const value = JSON.parse(localStorage.getItem(key(userId)) ?? "null");
    if (
      !value ||
      !networks.includes(value.input?.network) ||
      typeof value.input?.requestId !== "string" ||
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value.input.requestId)
    )
      return null;
    const common = {
      network: value.input.network as CardNetwork,
      requestId: value.input.requestId as string,
    };
    if (value.kind === "issue" && products.includes(value.input.product))
      // Legacy drafts retain their key and are bound to their storage owner,
      // never to whichever account the shared session cookie currently names.
      return {
        kind: "issue",
        input: {
          ...common,
          product: value.input.product as CardProductId,
          expectedUserId: userId,
          ...(typeof value.input.profileUpdatedAt === "string"
            ? { profileUpdatedAt: value.input.profileUpdatedAt }
            : {}),
        },
      };
    if (
      value.kind === "topup" &&
      typeof value.cardId === "string" &&
      typeof value.input.amountUsd === "string" &&
      /^\d+(\.\d{1,2})?$/.test(value.input.amountUsd)
    ) {
      return {
        kind: "topup",
        cardId: value.cardId,
        input: { ...common, amountUsd: value.input.amountUsd },
      };
    }
  } catch {
    /* Storage can be blocked. A new submission requires working storage. */
  }
  return null;
}

export function storeCardRequest(userId: string, request: CardRequest) {
  try {
    // Explicit allowlist: names/email live only in the encrypted server profile.
    const common = { network: request.input.network, requestId: request.input.requestId };
    const safe =
      request.kind === "issue"
        ? {
            kind: "issue",
            input: {
              ...common,
              product: request.input.product,
              expectedUserId: userId,
              ...(request.input.profileUpdatedAt === undefined
                ? {}
                : { profileUpdatedAt: request.input.profileUpdatedAt }),
            },
          }
        : {
            kind: "topup",
            cardId: request.cardId,
            input: { ...common, amountUsd: request.input.amountUsd },
          };
    localStorage.setItem(key(userId), JSON.stringify(safe));
  } catch {
    throw new Error(
      "Allow browser storage before requesting an invoice so this request can be recovered after a reload.",
    );
  }
}

export function clearCardRequest(userId: string, requestId: string) {
  try {
    if (readCardRequest(userId)?.input.requestId === requestId)
      localStorage.removeItem(key(userId));
  } catch {
    /* Keep the same key available for a safe replay if removal fails. */
  }
}

export function isConfirmedRejection(error: unknown) {
  // An outage can happen after an earlier attempt was accepted. Never discard
  // its key on unavailable/5xx responses, even when the error code looks known.
  // Account changes, pending operations and idempotency conflicts need the original key
  // retained: they do not establish that no earlier request was accepted.
  return (
    error instanceof ApiError &&
    ((error.status === 400 && ["VALIDATION", "CARD_EMAIL_REQUIRED"].includes(error.code)) ||
      (error.status === 409 &&
        ["CARD_NOT_READY", "CARD_ALREADY_EXISTS", "CARD_PROFILE_CHANGED"].includes(error.code)))
  );
}
