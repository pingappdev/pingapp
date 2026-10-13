import type { CardOperation, CardSummary } from "@/api/cards";

/**
 * Where a card is in its life, from the card record and its latest operation.
 * Setup stages replace the card view until the provider issues the card.
 */
export type SetupStage =
  "preparing" | "pay" | "expired" | "issuing" | "review" | "failed" | "checking";
export type CardStage = { kind: "setup"; stage: SetupStage } | { kind: "active" };

export function cardStage(card: CardSummary, operation: CardOperation | undefined): CardStage {
  if (card.issueStatus === "issued") return { kind: "active" };
  const issue = operation?.kind === "issue" ? operation : undefined;
  if (card.issueStatus === "failed" || issue?.status === "failed")
    return { kind: "setup", stage: "failed" };
  if (issue?.status === "review") return { kind: "setup", stage: "review" };
  if (
    card.issueStatus === "paid_pending_issue" ||
    issue?.status === "processing" ||
    issue?.status === "completed"
  )
    return { kind: "setup", stage: "issuing" };
  if (issue?.status === "expired") return { kind: "setup", stage: "expired" };
  if (issue?.status === "awaiting_payment") {
    const expiresAt = issue.invoice?.expiresAt;
    return {
      kind: "setup",
      stage: expiresAt && Date.parse(expiresAt) <= Date.now() ? "expired" : "pay",
    };
  }
  if (issue?.status === "created" || issue?.status === "submitting")
    return { kind: "setup", stage: "preparing" };
  return { kind: "setup", stage: "checking" };
}

const setupLabels: Record<SetupStage, string> = {
  preparing: "Preparing invoice",
  pay: "Setup fee due",
  expired: "Invoice expired",
  issuing: "Issuing",
  review: "Checking payment",
  failed: "Not issued",
  checking: "Checking status",
};

/** Short label for the card list: what this card needs, not its raw provider status. */
export function cardStageLabel(
  card: CardSummary,
  operation: CardOperation | undefined,
): string | null {
  const stage = cardStage(card, operation);
  if (stage.kind === "setup") return setupLabels[stage.stage];
  if (card.frozen === true) return "Frozen";
  if (operation?.kind === "topup" && operation.status === "awaiting_payment") return "Top-up due";
  if (
    operation?.kind === "topup" &&
    ["created", "submitting", "processing", "review"].includes(operation.status)
  )
    return "Top-up pending";
  return null;
}

/** Whether this card is waiting on the user, so the list can draw attention to it. */
export function cardNeedsAction(card: CardSummary, operation: CardOperation | undefined): boolean {
  const stage = cardStage(card, operation);
  return (
    (stage.kind === "setup" && stage.stage === "pay") ||
    (stage.kind === "active" &&
      operation?.kind === "topup" &&
      operation.status === "awaiting_payment")
  );
}
