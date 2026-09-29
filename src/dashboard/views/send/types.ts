import type { Address, ResolveResponse } from "../../../api/types";

export type Recipient = {
  kind: "phone" | "address" | "intent";
  address: Address;
  name: string;
  phone?: string;
  phoneMasked?: string;
  contactId?: string;
  linkedAt?: string;
  recentlyLinked?: boolean;
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
    address: response.recipient.address,
    name: response.recipient.displayName || "PingApp user",
    phone,
    phoneMasked: response.phoneMasked,
    contactId,
    linkedAt: response.recipient.linkedAt,
    recentlyLinked: response.recipient.recentlyLinked,
    underReview: response.recipient.underReview,
    previouslySentByMe: response.recipient.previouslySentByMe,
  };
}

export function recipientWarnings(recipient: Recipient): string[] {
  const warnings: string[] = [];
  if (recipient.recentlyLinked && recipient.linkedAt) {
    const days = Math.max(
      0,
      Math.floor((Date.now() - Date.parse(recipient.linkedAt)) / 86_400_000),
    );
    warnings.push(
      `Linked ${days} day${days === 1 ? "" : "s"} ago: confirm with them before sending large amounts.`,
    );
  }
  if (recipient.underReview)
    warnings.push(
      "Ownership of this number is under review. Confirm the address with the recipient another way.",
    );
  if (recipient.previouslySentByMe === false) warnings.push("First time sending to this wallet.");
  return warnings;
}
