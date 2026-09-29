import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { erc20Abi } from "viem";
import { getAccount } from "wagmi/actions";
import { useSendTransaction as useWagmiSend, useSwitchChain, useWriteContract } from "wagmi";
import { ApiError, endpoints } from "../../../api/client";
import { qk, sessionRevision, useRecordTransfer } from "../../../api/hooks";
import type { Intent, Me, ResolveResponse, TransferCreateInput, Token } from "../../../api/types";
import { chain } from "../../../config";
import { openConnect, wagmiAdapter } from "../../../wallet/appkit";
import type { Recipient } from "./types";
import { fromResolved, recipientChanged } from "./types";

export type ReviewedSend = {
  recipient: Recipient;
  token: Token;
  amount: string;
  amountRaw: string;
  intentId?: string;
};

type PendingRecord = { sender: string; input: TransferCreateInput };
const pendingKey = (sender: string) => `pingapp:pending-transfer-record:${sender.toLowerCase()}`;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  const candidate = error as {
    name?: string;
    code?: number;
    shortMessage?: string;
    message?: string;
  };
  const message = candidate.shortMessage ?? candidate.message ?? "The wallet request failed.";
  if (
    candidate.name === "UserRejectedRequestError" ||
    candidate.code === 4001 ||
    /user rejected|user denied/i.test(message)
  )
    return "Cancelled in your wallet.";
  if (/insufficient funds/i.test(message)) return "Not enough ETH for the amount plus network fee.";
  if (/revert|execution reverted/i.test(message))
    return "The token contract rejected this transfer. Some Stock Tokens can only be sent to eligible wallets.";
  return message.length > 220 ? `${message.slice(0, 217)}…` : message;
}

export function useSendTransaction(
  me: Me | null,
  onChangedRecipient: (
    recipient: Recipient | null,
    resolution?: ResolveResponse,
    requestedPhone?: string,
  ) => void,
) {
  const queryClient = useQueryClient();
  const { sendTransactionAsync } = useWagmiSend();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const record = useRecordTransfer();
  const [pending, setPending] = useState<PendingRecord | null>(null);
  const [tracked, setTracked] = useState<{ id: string; sender: string; userId: string } | null>(
    null,
  );
  const [recordFailure, setRecordFailure] = useState<{ sender: string; message: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const actionRunning = useRef(false);
  const displayedSession = queryClient.getQueryData<Me | null>(qk.session);
  const sameSession =
    !!me &&
    displayedSession?.id === me.id &&
    displayedSession.address.toLowerCase() === me.address.toLowerCase();
  const visiblePending =
    sameSession && me && pending?.sender.toLowerCase() === me.address.toLowerCase()
      ? pending
      : null;
  const visibleTransferId =
    sameSession &&
    me &&
    tracked?.sender.toLowerCase() === me.address.toLowerCase() &&
    tracked.userId === me.id
      ? tracked.id
      : null;
  const visibleRecordError =
    sameSession && me && recordFailure?.sender.toLowerCase() === me.address.toLowerCase()
      ? recordFailure.message
      : "";

  useEffect(() => {
    if (!me) return;
    try {
      const stored = sessionStorage.getItem(pendingKey(me.address));
      const parsed = stored ? (JSON.parse(stored) as PendingRecord) : null;
      if (
        parsed?.sender.toLowerCase() === me.address.toLowerCase() &&
        /^0x[0-9a-fA-F]{64}$/.test(parsed.input.txHash)
      )
        setPending(parsed);
      else setPending(null);
    } catch {
      /* A damaged draft must not enable a wallet resend. */
    }
  }, [me]);

  function persist(next: PendingRecord | null, sender?: string) {
    setPending(next);
    try {
      if (next) sessionStorage.setItem(pendingKey(next.sender), JSON.stringify(next));
      else if (sender) sessionStorage.removeItem(pendingKey(sender));
    } catch {
      /* The current page still retains the transaction hash. */
    }
  }

  function currentAccount(expected: Me, expectedRevision: number): boolean {
    const currentSession = queryClient.getQueryData<Me | null>(qk.session);
    const account = getAccount(wagmiAdapter.wagmiConfig);
    return (
      sessionRevision(queryClient) === expectedRevision &&
      !!currentSession &&
      currentSession.id === expected.id &&
      currentSession.address.toLowerCase() === expected.address.toLowerCase() &&
      account.isConnected &&
      account.address?.toLowerCase() === expected.address.toLowerCase()
    );
  }

  const sessionChangedMessage =
    "Your wallet or PingApp session changed after submission. Reconnect the original sending wallet and sign in to save this transaction.";

  async function save(input: TransferCreateInput, expected: Me, expectedRevision: number) {
    if (!currentAccount(expected, expectedRevision)) {
      setRecordFailure({ sender: expected.address, message: sessionChangedMessage });
      toast.error(sessionChangedMessage);
      return;
    }
    try {
      const { transfer } = await record.mutateAsync(input);
      if (
        transfer.from.address.toLowerCase() !== expected.address.toLowerCase() ||
        transfer.txHash.toLowerCase() !== input.txHash.toLowerCase()
      ) {
        setRecordFailure({
          sender: expected.address,
          message:
            "PingApp returned a transfer for another wallet. Keep this hash and contact support.",
        });
        return;
      }
      if (!currentAccount(expected, expectedRevision)) {
        setRecordFailure({ sender: expected.address, message: sessionChangedMessage });
        return;
      }
      setTracked({ id: transfer.id, sender: expected.address, userId: expected.id });
      setRecordFailure(null);
      persist(null, expected.address);
    } catch (error) {
      setRecordFailure({ sender: expected.address, message: errorMessage(error) });
    }
  }

  async function execute(review: ReviewedSend) {
    if (actionRunning.current || busy || visiblePending || visibleTransferId || !me) return;
    const expectedRevision = sessionRevision(queryClient);
    try {
      const stored = sessionStorage.getItem(pendingKey(me.address));
      const previous = stored ? (JSON.parse(stored) as PendingRecord) : null;
      if (
        previous?.sender.toLowerCase() === me.address.toLowerCase() &&
        /^0x[0-9a-fA-F]{64}$/.test(previous.input.txHash)
      ) {
        setPending(previous);
        return;
      }
    } catch {
      /* Continue with the current page state if storage is unavailable. */
    }
    actionRunning.current = true;
    setBusy(true);
    try {
      if (!currentAccount(me, expectedRevision)) {
        toast.error("Connect the wallet you signed in with.");
        await openConnect();
        return;
      }
      const accountBeforeSwitch = getAccount(wagmiAdapter.wagmiConfig);
      if (accountBeforeSwitch.chainId !== chain.id) await switchChainAsync({ chainId: chain.id });
      if (!currentAccount(me, expectedRevision))
        throw new Error("Connect the wallet you signed in with.");

      if (review.intentId) {
        const { items } = await endpoints.intents.list("open");
        if (!currentAccount(me, expectedRevision)) throw new Error(sessionChangedMessage);
        const fresh: Intent | undefined = items.find((item) => item.id === review.intentId);
        if (
          !fresh ||
          fresh.status !== "ready" ||
          !fresh.recipient ||
          !Number.isFinite(Date.parse(fresh.expiresAt)) ||
          Date.parse(fresh.expiresAt) <= Date.now() ||
          fresh.recipient.address.toLowerCase() !== review.recipient.address.toLowerCase() ||
          fresh.token.address.toLowerCase() !== review.token.address.toLowerCase() ||
          fresh.amountRaw !== review.amountRaw
        ) {
          onChangedRecipient(null);
          throw new Error("This pending send changed or expired. Review it again from Requests.");
        }
      } else if (review.recipient.kind === "phone" && review.recipient.phone) {
        const response = await endpoints.resolve(review.recipient.phone);
        if (!currentAccount(me, expectedRevision)) throw new Error(sessionChangedMessage);
        if (response.status !== "registered") {
          onChangedRecipient(null, response, review.recipient.phone);
          throw new Error("This number no longer points to a wallet. Please review again.");
        }
        const fresh = fromResolved(response, review.recipient.phone, review.recipient.contactId);
        if (fresh.address.toLowerCase() !== review.recipient.address.toLowerCase()) {
          onChangedRecipient(fresh, response);
          throw new Error("This number now points to a different wallet. Please review again.");
        }
        if (recipientChanged(review.recipient, fresh)) {
          onChangedRecipient(fresh, response);
          throw new Error(
            fresh.underReview && !review.recipient.underReview
              ? "Ownership of this number is now under review. Check the address and review again."
              : "This recipient's details changed. Check the address and review again.",
          );
        }
      }

      // Re-read after all awaited network calls. Bind the request to the signed-in wallet and chain.
      const account = getAccount(wagmiAdapter.wagmiConfig);
      if (!currentAccount(me, expectedRevision) || account.chainId !== chain.id)
        throw new Error("Connect the wallet you signed in with on Robinhood Chain.");
      const inputBase = {
        tokenAddress: review.token.address,
        amountRaw: review.amountRaw,
        toAddress: review.recipient.address,
        ...(review.recipient.kind === "phone" ? { recipientPhone: review.recipient.phone } : {}),
        ...(review.recipient.contactId ? { contactId: review.recipient.contactId } : {}),
        ...(review.intentId ? { intentId: review.intentId } : {}),
      };
      const hash =
        review.token.kind === "native"
          ? await sendTransactionAsync({
              account: me.address,
              chainId: chain.id,
              to: review.recipient.address,
              value: BigInt(review.amountRaw),
            })
          : await writeContractAsync({
              account: me.address,
              chainId: chain.id,
              address: review.token.address,
              abi: erc20Abi,
              functionName: "transfer",
              args: [review.recipient.address, BigInt(review.amountRaw)],
            });
      const input: TransferCreateInput = { ...inputBase, txHash: hash };
      persist({ sender: me.address, input });
      if (!currentAccount(me, expectedRevision)) {
        setRecordFailure({ sender: me.address, message: sessionChangedMessage });
        toast.error(sessionChangedMessage);
        return;
      }
      await save(input, me, expectedRevision);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      actionRunning.current = false;
      setBusy(false);
    }
  }

  async function retryRecord() {
    if (actionRunning.current || !visiblePending || busy || !me) return;
    const expectedRevision = sessionRevision(queryClient);
    actionRunning.current = true;
    setBusy(true);
    try {
      if (!currentAccount(me, expectedRevision)) {
        setRecordFailure({ sender: me.address, message: sessionChangedMessage });
        toast.error(sessionChangedMessage);
        await openConnect();
        return;
      }
      await save(visiblePending.input, me, expectedRevision);
    } finally {
      actionRunning.current = false;
      setBusy(false);
    }
  }

  function reset() {
    if (visiblePending) return;
    setTracked(null);
    setRecordFailure(null);
  }

  return {
    execute,
    retryRecord,
    reset,
    pending: visiblePending,
    transferId: visibleTransferId,
    recordError:
      visibleRecordError ||
      (visiblePending ? "This transaction still needs to be saved to Activity." : ""),
    busy,
  };
}
