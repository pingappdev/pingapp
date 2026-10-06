import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  cardKeys,
  cardsApi,
  type CardOperation,
  type CardNetwork,
  type CardProductId,
} from "@/api/cards";
import { qk, sessionRevision } from "@/api/hooks";
import { ApiError } from "@/api/client";
import type { Me } from "@/api/types";
import {
  clearCardRequest,
  isConfirmedRejection,
  readCardRequest,
  storeCardRequest,
  type CardRequest,
} from "./requests";

export function useCardRequest(userId: string) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(() => readCardRequest(userId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<CardOperation | null>(null);
  const [accountChanged, setAccountChanged] = useState(false);
  const accountBlocked = useRef(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const sync = () => setPending(readCardRequest(userId));
    window.addEventListener("storage", sync);
    return () => {
      mounted.current = false;
      window.removeEventListener("storage", sync);
    };
  }, [userId]);

  const submit = useCallback(
    async (
      input?:
        | {
            kind: "issue";
            email: string;
            cardholderName: string | null;
            product: CardProductId;
            network: CardNetwork;
          }
        | { kind: "topup"; cardId: string; amountUsd: string; network: CardNetwork },
    ) => {
      if (lock.current || accountBlocked.current) return false;
      lock.current = true;
      setBusy(true);
      setError(null);
      const revision = sessionRevision(queryClient);
      const current = () =>
        mounted.current &&
        sessionRevision(queryClient) === revision &&
        queryClient.getQueryData<Me | null>(qk.session)?.id === userId;
      let request = readCardRequest(userId);
      try {
        if (!current()) return false;
        if (!request) {
          if (!input)
            throw new Error(
              "No unresolved request was found. Refresh the card screen before continuing.",
            );
          let profileUpdatedAt: string | undefined;
          if (input.kind === "issue") {
            const { profile } = await cardsApi.saveProfile(
              input.email,
              userId,
              input.cardholderName,
            );
            if (!current()) return false;
            if (!profile?.updatedAt || !Number.isFinite(Date.parse(profile.updatedAt)))
              throw new Error(
                "Could not confirm your saved card details. Please review the application and submit again.",
              );
            profileUpdatedAt = profile.updatedAt;
          }
          // Recheck after saving the profile: another tab may have submitted.
          request =
            readCardRequest(userId) ??
            (input.kind === "issue"
              ? {
                  kind: "issue",
                  input: {
                    product: input.product,
                    network: input.network,
                    requestId: crypto.randomUUID(),
                    expectedUserId: userId,
                    profileUpdatedAt,
                  },
                }
              : {
                  kind: "topup",
                  cardId: input.cardId,
                  input: {
                    amountUsd: input.amountUsd,
                    network: input.network,
                    requestId: crypto.randomUUID(),
                  },
                });
          storeCardRequest(userId, request);
          setPending(request);
        }
        if (!current()) return false;
        const { operation } =
          request.kind === "issue"
            ? await cardsApi.issue({ ...request.input, expectedUserId: userId })
            : await cardsApi.topup(request.cardId, request.input);
        if (
          !operation?.id ||
          !operation.cardId ||
          !operation.status ||
          typeof operation.createdAt !== "string" ||
          typeof operation.updatedAt !== "string" ||
          operation.kind !== request.kind
        )
          throw new Error(
            "The server response did not confirm the request. Recover the same request to check its status.",
          );
        // Clear only the request this response acknowledged, even if a tab changed accounts.
        clearCardRequest(userId, request.input.requestId);
        if (!current()) return false;
        setPending(readCardRequest(userId));
        setAccepted(operation);
        void queryClient.invalidateQueries({ queryKey: cardKeys.account(userId) });
        return true;
      } catch (err) {
        if (!current()) return false;
        if (err instanceof ApiError && err.code === "ACCOUNT_CHANGED") {
          accountBlocked.current = true;
          setAccountChanged(true);
          // Do not refetch B's data into A's cache or retry A's request under B.
          // A full session refresh is an explicit user action in the card view.
          void queryClient.cancelQueries({ queryKey: cardKeys.account(userId) });
          return false;
        }
        if (request && isConfirmedRejection(err)) {
          clearCardRequest(userId, request.input.requestId);
          setPending(readCardRequest(userId));
        }
        setError(
          err instanceof ApiError && err.code === "CARD_PROFILE_CHANGED"
            ? "Your card contact details changed. Open the card application again to review them before submitting."
            : err instanceof Error
              ? err.message
              : "Could not confirm the request. Try recovering it.",
        );
        void queryClient.invalidateQueries({ queryKey: cardKeys.list(userId) });
        return false;
      } finally {
        lock.current = false;
        if (current()) setBusy(false);
      }
    },
    [queryClient, userId],
  );
  return { pending, busy, error, accepted, accountChanged, submit };
}
