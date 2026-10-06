import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiRequestOptions } from "./types";

export type CardNetwork = "tron" | "bsc" | "ethereum" | "polygon";
export type CardOperationStatus =
  | "created"
  | "submitting"
  | "awaiting_payment"
  | "processing"
  | "completed"
  | "failed"
  | "expired"
  | "review";
export type CardInvoice = {
  paymentId: string | null;
  address: string | null;
  amount: string | null;
  payCurrency: string;
  network: CardNetwork;
  expiresAt: string | null;
  url: string | null;
  amountUsd: string | null;
  amountOnCardUsd: string | null;
};
export type CardOperation = {
  id: string;
  cardId: string;
  kind: "issue" | "topup";
  status: CardOperationStatus;
  invoice: CardInvoice | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
export type CardSummary = {
  id: string;
  product: string;
  network: string;
  currency: "USD";
  issueStatus: string;
  last4: string | null;
  frozen: boolean | null;
  balanceUsd: string | null;
  pendingTopupUsd: string | null;
  balanceAsOf: string | null;
  issuedAt: string | null;
  createdAt: string;
  latestOperation: CardOperation | null;
  monthlySpending: { amountUsd: string | null; complete: boolean; periodStart: string };
};
export type CardTransaction = {
  id: string;
  type: string;
  status: string;
  amount: string;
  currency: string;
  merchant: string | null;
  occurredAt: string;
  direction: "debit" | "credit";
};
export type CardsConfig = {
  enabled: boolean;
  sandbox: boolean;
  products: Array<{
    id: string;
    name: string;
    network: string;
    currency: "USD";
    issuePriceUsd: string | null;
  }>;
  networks: Array<{ id: CardNetwork; label: string; payCurrency: string }>;
  capabilities: { freeze: false; spendingLimits: false };
};
export type CardDetails = {
  number: string;
  expiry: string;
  cvv: string;
  holderName: string | null;
};
export type IssueCardInput = { product: "visa"; network: CardNetwork; requestId: string };
export type TopupCardInput = { amountUsd: string; network: CardNetwork; requestId: string };

const cardPath = (id: string) => `/v1/cards/${encodeURIComponent(id)}`;
export const cardsApi = {
  config: (options?: ApiRequestOptions) => api<CardsConfig>("/v1/cards/config", options),
  profile: (options?: ApiRequestOptions) =>
    api<{ profile: { email: string } | null }>("/v1/cards/profile", options),
  saveProfile: (email: string, options?: ApiRequestOptions) =>
    api<{ profile: { email: string } | null }>("/v1/cards/profile", {
      method: "PATCH",
      body: { email },
      ...options,
    }),
  list: (options?: ApiRequestOptions) => api<{ items: CardSummary[] }>("/v1/cards", options),
  get: (id: string, options?: ApiRequestOptions) =>
    api<{ card: CardSummary }>(cardPath(id), options),
  issue: (input: IssueCardInput, options?: ApiRequestOptions) =>
    api<{ operation: CardOperation }>("/v1/cards/issue", {
      method: "POST",
      body: input,
      ...options,
    }),
  operation: (id: string, options?: ApiRequestOptions) =>
    api<{ operation: CardOperation }>(`/v1/cards/operations/${encodeURIComponent(id)}`, options),
  topup: (id: string, input: TopupCardInput, options?: ApiRequestOptions) =>
    api<{ operation: CardOperation }>(`${cardPath(id)}/topups`, {
      method: "POST",
      body: input,
      ...options,
    }),
  transactions: (id: string, cursor: string | null, options?: ApiRequestOptions) => {
    const params = new URLSearchParams({ limit: "20" });
    if (cursor) params.set("cursor", cursor);
    return api<{ items: CardTransaction[]; nextCursor: string | null; complete: boolean }>(
      `${cardPath(id)}/transactions?${params}`,
      options,
    );
  },
  // Deliberately not a query/mutation hook: PAN/CVV must never enter the query cache.
  reveal: (id: string, options?: ApiRequestOptions) =>
    api<CardDetails>(`${cardPath(id)}/reveal`, { method: "POST", cache: "no-store", ...options }),
};

export const cardKeys = {
  account: (userId: string) => ["pingapp", "cards", userId] as const,
  config: (userId: string) => [...cardKeys.account(userId), "config"] as const,
  list: (userId: string) => [...cardKeys.account(userId), "list"] as const,
  operation: (userId: string, id: string) =>
    [...cardKeys.account(userId), "operation", id] as const,
  transactions: (userId: string, id: string) =>
    [...cardKeys.account(userId), "transactions", id] as const,
};

export function isOperationPending(operation: CardOperation | null | undefined) {
  return Boolean(operation && !["completed", "failed", "expired"].includes(operation.status));
}

export function useCardsConfig(userId: string) {
  return useQuery({
    queryKey: cardKeys.config(userId),
    queryFn: ({ signal }) => cardsApi.config({ signal }),
    staleTime: 60_000,
  });
}
export function useCards(userId: string) {
  return useQuery({
    queryKey: cardKeys.list(userId),
    queryFn: async ({ signal }) => (await cardsApi.list({ signal })).items,
    refetchInterval: 15_000,
  });
}
export function useCardOperation(userId: string, id: string | undefined) {
  return useQuery({
    queryKey: cardKeys.operation(userId, id ?? ""),
    queryFn: async ({ signal }) => (await cardsApi.operation(id!, { signal })).operation,
    enabled: Boolean(id),
    refetchInterval: (query) =>
      isOperationPending(query.state.data) || !query.state.data ? 5_000 : false,
  });
}
export function useCardTransactions(userId: string, id: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: cardKeys.transactions(userId, id),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => cardsApi.transactions(id, pageParam, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
    refetchInterval: 30_000,
  });
}
