import type { CardOperation, CardSummary } from "@/api/cards";

// The accepted response is only a bridge until the server list knows the request.
// It must never replace a list snapshot for the same operation or a newer request.
export function latestCardOperations(cards: CardSummary[], accepted: CardOperation | null) {
  const byCard = new Map<string, CardOperation>();
  for (const card of cards) if (card.latestOperation) byCard.set(card.id, card.latestOperation);
  if (accepted) {
    const listed = byCard.get(accepted.cardId);
    if (!listed || (listed.id !== accepted.id && accepted.createdAt > listed.createdAt))
      byCard.set(accepted.cardId, accepted);
  }
  return [...byCard.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function newestOperation(listed: CardOperation, polled: CardOperation | undefined) {
  return polled?.id === listed.id && polled.updatedAt >= listed.updatedAt ? polled : listed;
}

export function balanceNeedsRefresh(card: CardSummary | undefined, operation: CardOperation) {
  if (operation.kind !== "topup" || operation.status !== "completed") return false;
  const asOf = Date.parse(card?.balanceAsOf ?? "");
  const completedAt = Date.parse(operation.updatedAt);
  return !Number.isFinite(asOf) || !Number.isFinite(completedAt) || asOf < completedAt;
}

export function withNewerBalance(card: CardSummary, snapshot: CardSummary | undefined) {
  if (!snapshot?.balanceAsOf || snapshot.id !== card.id) return card;
  const asOf = Date.parse(snapshot.balanceAsOf);
  if (!Number.isFinite(asOf) || asOf <= Date.parse(card.balanceAsOf ?? "1970-01-01")) return card;
  return {
    ...card,
    balanceUsd: snapshot.balanceUsd,
    pendingTopupUsd: snapshot.pendingTopupUsd,
    balanceAsOf: snapshot.balanceAsOf,
  };
}
