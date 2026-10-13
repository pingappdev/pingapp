import { useEffect } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  cardKeys,
  cardsApi,
  isOperationPending,
  type CardOperation,
  type CardSummary,
} from "@/api/cards";
import {
  balanceNeedsRefresh,
  latestCardOperations,
  newestOperation,
  withNewerBalance,
} from "./operations";

export function useCardLiveState(
  userId: string,
  cards: CardSummary[],
  accepted: CardOperation | null,
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const initial = latestCardOperations(cards, accepted);
  // Observers belong to the card screen, independently of which panels are shown.
  const operationQueries = useQueries({
    queries: initial.map((operation) => ({
      queryKey: cardKeys.operation(userId, operation.id),
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await cardsApi.operation(operation.id, { signal })).operation,
      enabled,
      refetchInterval: (query: { state: { data: CardOperation | undefined } }) =>
        enabled && isOperationPending(newestOperation(operation, query.state.data)) ? 5_000 : false,
    })),
  });
  const observations = initial.map((operation, index) => ({
    operation: newestOperation(operation, operationQueries[index].data),
    refreshing: operationQueries[index].isFetching,
    refreshError: operationQueries[index].isError,
    refresh: () => {
      void operationQueries[index].refetch();
    },
  }));
  const stateChanges = JSON.stringify(
    observations.map(({ operation }) => [operation.id, operation.cardId, operation.status]),
  );
  useEffect(() => {
    if (!enabled || stateChanges === "[]") return;
    void queryClient.invalidateQueries({ queryKey: cardKeys.list(userId) });
    for (const [, cardId, status] of JSON.parse(stateChanges) as string[][]) {
      if (status === "completed")
        void queryClient.invalidateQueries({ queryKey: cardKeys.transactions(userId, cardId) });
    }
  }, [stateChanges, enabled, queryClient, userId]);

  const completedTopups = observations
    .map(({ operation }) => operation)
    .filter((operation) => operation.kind === "topup" && operation.status === "completed");
  const balanceQueries = useQueries({
    queries: completedTopups.map((operation) => ({
      queryKey: [...cardKeys.account(userId), "detail", operation.cardId],
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await cardsApi.get(operation.cardId, { signal })).card,
      enabled:
        enabled &&
        balanceNeedsRefresh(
          cards.find((card) => card.id === operation.cardId),
          operation,
        ),
      refetchInterval: (query: { state: { data: CardSummary | undefined } }) =>
        enabled && balanceNeedsRefresh(query.state.data, operation) ? 3_000 : false,
    })),
  });
  const snapshots = new Map(
    completedTopups.map((operation, index) => [operation.cardId, balanceQueries[index].data]),
  );
  const freshBalances = JSON.stringify(
    completedTopups.flatMap((operation) => {
      const snapshot = snapshots.get(operation.cardId);
      return snapshot && !balanceNeedsRefresh(snapshot, operation)
        ? [[operation.cardId, snapshot.balanceAsOf]]
        : [];
    }),
  );
  useEffect(() => {
    if (!enabled || freshBalances === "[]") return;
    void queryClient.invalidateQueries({ queryKey: cardKeys.list(userId) });
    for (const [cardId] of JSON.parse(freshBalances) as string[][])
      void queryClient.invalidateQueries({ queryKey: cardKeys.transactions(userId, cardId) });
  }, [freshBalances, enabled, queryClient, userId]);

  const updatedCards = cards.map((card) => withNewerBalance(card, snapshots.get(card.id)));
  const refreshingBalances = new Set(
    completedTopups
      .filter((operation) =>
        balanceNeedsRefresh(
          updatedCards.find((card) => card.id === operation.cardId),
          operation,
        ),
      )
      .map((operation) => operation.cardId),
  );
  return { cards: updatedCards, observations, refreshingBalances };
}
