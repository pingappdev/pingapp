import type { ResolveResponse } from "../../../api/types";

export type Recipient = {
  kind: "phone" | "intent";
  recipientRef?: string;
  name: string;
  phone?: string;
  phoneMasked?: string;
  contactId?: string;
  underReview?: boolean;
  previouslySentByMe?: boolean;
};

export function fromResolved(
  response: Extract<ResolveResponse, { status: "registered" }>,
  phone: string,
  contactId?: string,
): Recipient {
  return {
    kind: "phone",
    recipientRef: response.recipient.recipientRef,
    name: response.recipient.displayName || "PingApp user",
    phone,
    phoneMasked: response.phoneMasked,
    contactId,
    underReview: response.recipient.underReview,
    previouslySentByMe: response.recipient.previouslySentByMe,
  };
}

export function recipientWarnings(
  recipient: Pick<Recipient, "underReview" | "previouslySentByMe">,
): string[] {
  const warnings: string[] = [];
  if (recipient.underReview)
    warnings.push(
      "Ownership of this number is under review. Delivery will wait until the review is resolved.",
    );
  if (recipient.previouslySentByMe === false)
    warnings.push("First time sending to this recipient.");
  return warnings;
}

/** A fresh phone lookup must be reviewed whenever identity or safety signals change. */
export function recipientChanged(reviewed: Recipient, fresh: Recipient): boolean {
  return (
    reviewed.recipientRef !== fresh.recipientRef ||
    reviewed.name !== fresh.name ||
    reviewed.phoneMasked !== fresh.phoneMasked ||
    reviewed.underReview !== fresh.underReview ||
    reviewed.previouslySentByMe !== fresh.previouslySentByMe
  );
}
