import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { erc20Abi } from "viem";
import { getAccount } from "wagmi/actions";
import { useSendTransaction as useWagmiSend, useSwitchChain, useWriteContract } from "wagmi";
import { ApiError, endpoints } from "../../../api/client";
import { qk, useRecordTransfer } from "../../../api/hooks";
import type { Intent, Me, ResolveResponse, TransferCreateInput, Token } from "../../../api/types";
import { chain } from "../../../config";
import { openConnect, wagmiAdapter } from "../../../wallet/appkit";
import type { Recipient } from "./types";
import { fromResolved } from "./types";

export type ReviewedSend = {
  recipient: Recipient;
  token: Token;
  amount: string;
  amountRaw: string;
  intentId?: string;
};

type PendingRecord = { sender: string; input: TransferCreateInput };
const PENDING_KEY = "pingapp:pending-transfer-record";

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
  onChangedRecipient: (recipient: Recipient | null, resolution?: ResolveResponse) => void,
) {
  const queryClient = useQueryClient();
  const { sendTransactionAsync } = useWagmiSend();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const record = useRecordTransfer();
  const [pending, setPending] = useState<PendingRecord | null>(null);
  const [transferId, setTransferId] = useState<string | null>(null);
  const [recordError, setRecordError] = useState("");
  const [busy, setBusy] = useState(false);
  const actionRunning = useRef(false);

  useEffect(() => {
    if (!me) return;
    try {
      const stored = sessionStorage.getItem(PENDING_KEY);
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

  function persist(next: PendingRecord | null) {
    setPending(next);
    try {
      if (next) sessionStorage.setItem(PENDING_KEY, JSON.stringify(next));
      else sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* The current page still retains the transaction hash. */
    }
  }

  function currentAccount(expected: Me): boolean {
    const currentSession = queryClient.getQueryData<Me | null>(qk.session);
    const account = getAccount(wagmiAdapter.wagmiConfig);
    return (
      !!currentSession &&
      currentSession.id === expected.id &&
      currentSession.address.toLowerCase() === expected.address.toLowerCase() &&
      account.isConnected &&
      account.address?.toLowerCase() === expected.address.toLowerCase()
    );
  }

  async function save(input: TransferCreateInput) {
    try {
      const { transfer } = await record.mutateAsync(input);
      setTransferId(transfer.id);
      setRecordError("");
      persist(null);
    } catch (error) {
      setRecordError(errorMessage(error));
    }
  }

  async function execute(review: ReviewedSend) {
    if (actionRunning.current || busy || pending || transferId || !me) return;
    actionRunning.current = true;
    setBusy(true);
    try {
      if (!currentAccount(me)) {
        toast.error("Connect the wallet you signed in with.");
        await openConnect();
        return;
      }
      const accountBeforeSwitch = getAccount(wagmiAdapter.wagmiConfig);
      if (accountBeforeSwitch.chainId !== chain.id) await switchChainAsync({ chainId: chain.id });
      if (!currentAccount(me)) throw new Error("Connect the wallet you signed in with.");

      if (review.intentId) {
        const { items } = await endpoints.intents.list("open");
        const fresh: Intent | undefined = items.find((item) => item.id === review.intentId);
        if (
          !fresh ||
          fresh.status !== "ready" ||
          !fresh.recipient ||
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
        if (response.status !== "registered") {
          onChangedRecipient(null, response);
          throw new Error("This number no longer points to a wallet. Please review again.");
        }
        const fresh = fromResolved(response, review.recipient.phone, review.recipient.contactId);
        if (fresh.address.toLowerCase() !== review.recipient.address.toLowerCase()) {
          onChangedRecipient(fresh, response);
          throw new Error("This number now points to a different wallet. Please review again.");
        }
        if (fresh.underReview && !review.recipient.underReview) {
          onChangedRecipient(fresh, response);
          throw new Error(
            "Ownership of this number is now under review. Check the address and review again.",
          );
        }
      }

      // Re-read after all awaited network calls. Bind the request to the signed-in wallet and chain.
      const account = getAccount(wagmiAdapter.wagmiConfig);
      if (!currentAccount(me) || account.chainId !== chain.id)
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
      await save(input);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      actionRunning.current = false;
      setBusy(false);
    }
  }

  async function retryRecord() {
    if (
      actionRunning.current ||
      !pending ||
      busy ||
      !me ||
      pending.sender.toLowerCase() !== me.address.toLowerCase()
    )
      return;
    actionRunning.current = true;
    setBusy(true);
    try {
      await save(pending.input);
    } finally {
      actionRunning.current = false;
      setBusy(false);
    }
  }

  function reset() {
    if (pending) return;
    setTransferId(null);
    setRecordError("");
  }

  return { execute, retryRecord, reset, pending, transferId, recordError, busy };
}
