import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { cardKeys, cardsApi, type CardOperation, type CardNetwork } from "@/api/cards";
import { qk, sessionRevision } from "@/api/hooks";
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
        | { kind: "issue"; email: string; network: CardNetwork }
        | { kind: "topup"; cardId: string; amountUsd: string; network: CardNetwork },
    ) => {
      if (lock.current) return false;
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
          if (input.kind === "issue") {
            await cardsApi.saveProfile(input.email);
            if (!current()) return false;
          }
          // Recheck after saving the profile: another tab may have submitted.
          request =
            readCardRequest(userId) ??
            (input.kind === "issue"
              ? {
                  kind: "issue",
                  input: {
                    product: "visa",
                    network: input.network,
                    requestId: crypto.randomUUID(),
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
            ? await cardsApi.issue(request.input)
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
        if (request && isConfirmedRejection(err)) {
          clearCardRequest(userId, request.input.requestId);
          setPending(readCardRequest(userId));
        }
        setError(
          err instanceof Error ? err.message : "Could not confirm the request. Try recovering it.",
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
  return { pending, busy, error, accepted, submit };
}
