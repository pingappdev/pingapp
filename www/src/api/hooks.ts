import { useEffect } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { ApiError, endpoints } from "./client";
import { isNativeBuild } from "../env";
import type {
  ContactCreateInput,
  AuthorizeSendInput,
  Address,
  IntentCreateInput,
  IntentStatusFilter,
  Me,
  NotificationReadInput,
  TransferCreateInput,
  TransferDirection,
} from "./types";

export const qk = {
  all: ["pingapp"] as const,
  config: ["pingapp", "config"] as const,
  session: ["pingapp", "auth", "session"] as const,
  me: ["pingapp", "me"] as const,
  sessions: ["pingapp", "sessions"] as const,
  tokens: ["pingapp", "tokens"] as const,
  balancesPrefix: ["pingapp", "wallet", "balances"] as const,
  balances: (refresh = false) => ["pingapp", "wallet", "balances", { refresh }] as const,
  contacts: ["pingapp", "contacts"] as const,
  transfersPrefix: ["pingapp", "transfers"] as const,
  transfers: (direction: TransferDirection = "all") => ["pingapp", "transfers", direction] as const,
  transfer: (id: string) => ["pingapp", "transfers", "detail", id] as const,
  intentsPrefix: ["pingapp", "intents"] as const,
  escrowsPrefix: ["pingapp", "escrows"] as const,
  escrows: (role: "sent" | "incoming") => ["pingapp", "escrows", role] as const,
  intents: (status: IntentStatusFilter = "open") => ["pingapp", "intents", status] as const,
  incomingIntents: ["pingapp", "intents", "incoming"] as const,
  claim: (code: string) => ["pingapp", "claims", code] as const,
  notifications: ["pingapp", "notifications"] as const,
};

function isUserQuery({ queryKey }: { queryKey: readonly unknown[] }): boolean {
  if (queryKey[0] !== qk.all[0]) return false;
  if (queryKey[1] === "config" || queryKey[1] === "tokens") return false;
  return !(queryKey[1] === "auth" && queryKey[2] === "session");
}

const sessionRevisions = new WeakMap<QueryClient, number>();

export function sessionRevision(queryClient: QueryClient): number {
  return sessionRevisions.get(queryClient) ?? 0;
}

/** Cancel old private requests before publishing a new session identity. */
export async function transitionSession(
  queryClient: QueryClient,
  next: Me | null,
  options: { expectedRevision?: number; cancelSessionQuery?: boolean } = {},
): Promise<boolean> {
  const previousRevision = sessionRevision(queryClient);
  if (options.expectedRevision !== undefined && options.expectedRevision !== previousRevision)
    return false;

  const previous = queryClient.getQueryData<Me | null>(qk.session);
  const identityChanged =
    previous === undefined ||
    previous?.id !== next?.id ||
    previous?.address.toLowerCase() !== next?.address.toLowerCase();
  const nextRevision =
    identityChanged || options.cancelSessionQuery ? previousRevision + 1 : previousRevision;
  if (nextRevision !== previousRevision) sessionRevisions.set(queryClient, nextRevision);

  if (options.cancelSessionQuery)
    await queryClient.cancelQueries({ queryKey: qk.session, exact: true });
  if (identityChanged) await queryClient.cancelQueries({ predicate: isUserQuery });
  if (sessionRevision(queryClient) !== nextRevision) return false;

  if (identityChanged) queryClient.removeQueries({ predicate: isUserQuery });
  queryClient.setQueryData<Me | null>(qk.session, next);
  return true;
}

const sessionClients = new Map<QueryClient, number>();
let authEventListenerInstalled = false;

function handleUnauthenticated(): void {
  for (const queryClient of sessionClients.keys()) {
    void transitionSession(queryClient, null, { cancelSessionQuery: true });
  }
}

function registerAuthCacheListener(queryClient: QueryClient): () => void {
  sessionClients.set(queryClient, (sessionClients.get(queryClient) ?? 0) + 1);
  if (typeof window !== "undefined" && !authEventListenerInstalled) {
    window.addEventListener("pingapp:unauthenticated", handleUnauthenticated);
    authEventListenerInstalled = true;
  }

  return () => {
    const count = sessionClients.get(queryClient) ?? 0;
    if (count <= 1) sessionClients.delete(queryClient);
    else sessionClients.set(queryClient, count - 1);
    if (typeof window !== "undefined" && authEventListenerInstalled && sessionClients.size === 0) {
      window.removeEventListener("pingapp:unauthenticated", handleUnauthenticated);
      authEventListenerInstalled = false;
    }
  };
}

export function useConfig() {
  return useQuery({
    queryKey: qk.config,
    queryFn: ({ signal }) => endpoints.config.get({ signal }),
    staleTime: Infinity,
  });
}

export function useSession() {
  const queryClient = useQueryClient();

  useEffect(() => registerAuthCacheListener(queryClient), [queryClient]);

  return useQuery({
    queryKey: qk.session,
    queryFn: async ({ signal }) => {
      const expectedRevision = sessionRevision(queryClient);
      try {
        const me =
          import.meta.env.VITE_TARGET === "native" && isNativeBuild
            ? await (await import("../auth/nativeSession")).readNativeSession(queryClient)
            : (await endpoints.auth.session({ signal })).me;
        const applied = await transitionSession(queryClient, me, { expectedRevision });
        return applied ? me : (queryClient.getQueryData<Me | null>(qk.session) ?? null);
      } catch (error) {
        if (error instanceof ApiError && error.code === "UNAUTHENTICATED") {
          const applied = await transitionSession(queryClient, null, { expectedRevision });
          return applied ? null : (queryClient.getQueryData<Me | null>(qk.session) ?? null);
        }
        throw error;
      }
    },
    retry: false,
    refetchOnMount: "always",
  });
}

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async ({ signal }) => (await endpoints.me.get({ signal })).me,
  });
}

export function useSessions() {
  return useQuery({
    queryKey: qk.sessions,
    queryFn: async ({ signal }) => (await endpoints.me.sessions({ signal })).items,
  });
}

export function useTokens() {
  return useQuery({
    queryKey: qk.tokens,
    queryFn: async ({ signal }) => (await endpoints.tokens.list({ signal })).items,
    staleTime: 60_000,
  });
}

export function useBalances(options: { refresh?: boolean; enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  return useQuery({
    queryKey: qk.balances(options.refresh),
    queryFn: ({ signal }) => endpoints.wallet.balances({ refresh: options.refresh }, { signal }),
    enabled,
    refetchInterval: enabled ? 30_000 : false,
  });
}

export function useContacts() {
  return useQuery({
    queryKey: qk.contacts,
    queryFn: async ({ signal }) => (await endpoints.contacts.list({ signal })).items,
  });
}

export function useTransfers(direction: TransferDirection = "all") {
  return useInfiniteQuery({
    queryKey: qk.transfers(direction),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      endpoints.transfers.list({ direction, cursor: pageParam ?? undefined }, { signal }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.items.some((item) => item.status === "submitted"))
        ? 10_000
        : false,
  });
}

export function useTransfer(id: string | undefined) {
  return useQuery({
    queryKey: qk.transfer(id ?? ""),
    queryFn: async ({ signal }) => {
      if (!id) throw new Error("A transfer id is required.");
      return (await endpoints.transfers.get(id, { signal })).transfer;
    },
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.status === "submitted" ? 4_000 : false),
  });
}

export function useIntents(status: IntentStatusFilter = "open") {
  return useQuery({
    queryKey: qk.intents(status),
    queryFn: async ({ signal }) => (await endpoints.intents.list(status, { signal })).items,
  });
}

export function useIncomingIntents() {
  return useQuery({
    queryKey: qk.incomingIntents,
    queryFn: async ({ signal }) => (await endpoints.intents.incoming({ signal })).items,
  });
}

export function useClaim(code: string | undefined) {
  return useQuery({
    queryKey: qk.claim(code ?? ""),
    queryFn: ({ signal }) => {
      if (!code) throw new Error("A claim code is required.");
      return endpoints.claims.get(code, { signal });
    },
    enabled: Boolean(code),
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: qk.notifications,
    queryFn: ({ signal }) => endpoints.notifications.list(50, { signal }),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useResolve() {
  return useMutation({ mutationFn: (phone: string) => endpoints.resolve(phone) });
}

export function useUpdateMe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { displayName: string }) => endpoints.me.update(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.me }),
        queryClient.invalidateQueries({ queryKey: qk.session }),
      ]);
    },
  });
}

export function useRequestOtp() {
  return useMutation({ mutationFn: (phone: string) => endpoints.phone.requestOtp(phone) });
}

export function useVerifyOtp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ phone, code }: { phone: string; code: string }) =>
      endpoints.phone.verify(phone, code),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.me }),
        queryClient.invalidateQueries({ queryKey: qk.session }),
        queryClient.invalidateQueries({ queryKey: qk.incomingIntents }),
      ]);
    },
  });
}

export function useUnlinkPhone() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => endpoints.phone.unlink(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.me }),
        queryClient.invalidateQueries({ queryKey: qk.session }),
      ]);
    },
  });
}

export function useCancelClaim() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => endpoints.phone.cancelClaim(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.me }),
        queryClient.invalidateQueries({ queryKey: qk.session }),
      ]);
    },
  });
}

export function useCreateContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ContactCreateInput) => endpoints.contacts.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.contacts }),
  });
}

export function useUpdateContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: Parameters<typeof endpoints.contacts.update>[1];
    }) => endpoints.contacts.update(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.contacts }),
  });
}

export function useRemoveContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => endpoints.contacts.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.contacts }),
  });
}

export function useRecordTransfer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TransferCreateInput) => endpoints.transfers.create(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.transfersPrefix }),
        queryClient.invalidateQueries({ queryKey: qk.balancesPrefix }),
        queryClient.invalidateQueries({ queryKey: qk.intentsPrefix }),
      ]);
    },
  });
}

export function useCreateIntent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IntentCreateInput) => endpoints.intents.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.intentsPrefix }),
  });
}

export function useCancelIntent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => endpoints.intents.cancel(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.intentsPrefix }),
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NotificationReadInput) => endpoints.notifications.read(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.notifications }),
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => endpoints.me.revokeSession(id),
    onSuccess: async (_data, id) => {
      const sessions = queryClient.getQueryData<Array<{ id: string; current: boolean }>>(
        qk.sessions,
      );
      if (sessions?.some((session) => session.id === id && session.current)) {
        await transitionSession(queryClient, null, { cancelSessionQuery: true });
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.sessions }),
        queryClient.invalidateQueries({ queryKey: qk.me }),
        queryClient.invalidateQueries({ queryKey: qk.session }),
      ]);
    },
  });
}

export function useRevokeOthers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => endpoints.me.revokeOthers(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.sessions }),
  });
}

export function useDeleteAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => endpoints.me.delete(),
    onSuccess: async () => {
      await transitionSession(queryClient, null, { cancelSessionQuery: true });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => endpoints.auth.logout(),
    onSuccess: async () => {
      await transitionSession(queryClient, null, { cancelSessionQuery: true });
    },
  });
}

export function useAuthorizeSend() {
  return useMutation({
    mutationFn: (input: AuthorizeSendInput) => endpoints.sends.authorize(input),
  });
}

export function useEscrows(role: "sent" | "incoming", enabled = true) {
  return useQuery({
    queryKey: qk.escrows(role),
    queryFn: async ({ signal }) => (await endpoints.escrows.list(role, { signal })).items,
    enabled,
    refetchInterval: 4_000,
  });
}

export function useClaimEscrow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => endpoints.escrows.claim(id),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.escrowsPrefix }),
        queryClient.invalidateQueries({ queryKey: ["pingapp", "claims"] }),
        queryClient.invalidateQueries({ queryKey: qk.balancesPrefix }),
      ]),
  });
}

export function useEscrowSubmitted() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, txHash }: { id: string; txHash: Address }) =>
      endpoints.escrows.submitted(id, txHash),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.escrowsPrefix }),
        queryClient.invalidateQueries({ queryKey: qk.balancesPrefix }),
      ]),
  });
}
