import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { erc20Abi } from "viem";
import { getAccount, getPublicClient } from "wagmi/actions";
import { useSwitchChain, useWriteContract } from "wagmi";
import { endpoints } from "../../../api/client";
import {
  qk,
  sessionRevision,
  useAuthorizeSend,
  useEscrowSubmitted,
  useRecordTransfer,
} from "../../../api/hooks";
import type {
  Address,
  Me,
  ResolveResponse,
  TransferCreateInput,
  Token,
  ConfigResponse,
} from "../../../api/types";
import { chain } from "../../../config";
import { openConnect, wagmiAdapter } from "../../../wallet/appkit";
import { pingRouterAbi } from "../../../wallet/pingRouterAbi";
import type { Recipient } from "./types";
import { fromResolved, recipientChanged } from "./types";
import { errorMessage } from "./errors";

export type ReviewedSend = {
  recipient: Recipient | (Omit<Recipient, "kind"> & { kind: "escrow"; phone: string });
  token: Token;
  amount: string;
  amountRaw: string;
  intentId?: string;
  router?: ConfigResponse["router"];
  escrowTtlDays?: number;
};

type PendingRecord =
  | { sender: string; mode?: "direct"; input: TransferCreateInput }
  | {
      sender: string;
      mode: "escrow";
      input: { txHash: Address; expectedSenderAddress: Address; escrowId: string };
    };
const pendingKey = (sender: string) => `pingapp:pending-transfer-record:${sender.toLowerCase()}`;

function restorePending(sender: Address): PendingRecord | null {
  try {
    const stored = sessionStorage.getItem(pendingKey(sender));
    if (!stored) return null;
    const parsed = JSON.parse(stored) as PendingRecord;
    if (
      parsed.sender?.toLowerCase() !== sender.toLowerCase() ||
      !parsed.input ||
      !/^0x[0-9a-fA-F]{64}$/.test(parsed.input.txHash)
    )
      return null;
    if (parsed.mode === "escrow") {
      if (!/^0x[0-9a-f]{64}$/i.test(parsed.input.escrowId)) return null;
      return { sender, mode: "escrow", input: { ...parsed.input, expectedSenderAddress: sender } };
    }
    // Older sender-keyed drafts predate the request precondition. Bind every retry to this sender.
    const recovered = { sender, input: { ...parsed.input, expectedSenderAddress: sender } };
    if (parsed.input.expectedSenderAddress?.toLowerCase() !== sender.toLowerCase()) {
      try {
        sessionStorage.setItem(pendingKey(sender), JSON.stringify(recovered));
      } catch {
        /* The in-memory draft still retains the hash. */
      }
    }
    return recovered;
  } catch {
    return null;
  }
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
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const record = useRecordTransfer();
  const authorize = useAuthorizeSend();
  const submitted = useEscrowSubmitted();
  const [pending, setPending] = useState<PendingRecord | null>(null);
  const [tracked, setTracked] = useState<{
    id: string;
    sender: string;
    userId: string;
    mode?: "direct" | "escrow";
  } | null>(null);
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
    tracked.userId === me.id &&
    tracked.mode !== "escrow"
      ? tracked.id
      : null;
  const visibleEscrowId =
    sameSession &&
    me &&
    tracked?.sender.toLowerCase() === me.address.toLowerCase() &&
    tracked.userId === me.id &&
    tracked.mode === "escrow"
      ? tracked.id
      : null;
  const visibleRecordError =
    sameSession && me && recordFailure?.sender.toLowerCase() === me.address.toLowerCase()
      ? recordFailure.message
      : "";

  useEffect(() => {
    if (!me) return;
    setPending(restorePending(me.address));
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
      const { transfer } = await record.mutateAsync({
        ...input,
        expectedSenderAddress: expected.address,
      });
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

  async function saveEscrow(
    input: { escrowId: string; txHash: Address },
    expected: Me,
    expectedRevision: number,
  ) {
    if (!currentAccount(expected, expectedRevision)) {
      setRecordFailure({ sender: expected.address, message: sessionChangedMessage });
      return;
    }
    try {
      const { escrow } = await submitted.mutateAsync({ id: input.escrowId, txHash: input.txHash });
      if (!currentAccount(expected, expectedRevision)) {
        setRecordFailure({ sender: expected.address, message: sessionChangedMessage });
        return;
      }
      if (
        escrow.id !== input.escrowId ||
        escrow.depositTxHash.toLowerCase() !== input.txHash.toLowerCase()
      ) {
        throw new Error(
          "The escrow receipt does not match this transaction. Keep the hash and contact support.",
        );
      }
      setTracked({ id: escrow.id, sender: expected.address, userId: expected.id, mode: "escrow" });
      setRecordFailure(null);
      persist(null, expected.address);
    } catch (error) {
      setRecordFailure({ sender: expected.address, message: errorMessage(error) });
    }
  }

  async function execute(review: ReviewedSend) {
    if (
      actionRunning.current ||
      busy ||
      visiblePending ||
      visibleTransferId ||
      visibleEscrowId ||
      !me
    )
      return;
    const expectedRevision = sessionRevision(queryClient);
    const previous = restorePending(me.address);
    if (previous) {
      setPending(previous);
      return;
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

      const routerSettings = (await endpoints.config.get()).router;
      if (!currentAccount(me, expectedRevision)) throw new Error(sessionChangedMessage);
      if (
        !!routerSettings?.enabled !== !!review.router?.enabled ||
        (routerSettings?.enabled &&
          routerSettings.address.toLowerCase() !== review.router?.address.toLowerCase())
      ) {
        throw new Error("Sending settings changed. Refresh and review again.");
      }

      if (review.intentId)
        throw new Error("This invitation cannot be completed. Start a new send by phone.");
      if (!routerSettings.enabled) throw new Error("Sending is temporarily unavailable.");
      {
        if (
          (review.recipient.kind !== "phone" && review.recipient.kind !== "escrow") ||
          !review.recipient.phone
        )
          throw new Error("Enter and verify a recipient phone number before sending.");
        const response = await endpoints.resolve(review.recipient.phone);
        if (!currentAccount(me, expectedRevision)) throw new Error(sessionChangedMessage);
        if (review.recipient.kind === "escrow") {
          if (response.status !== "not_registered") {
            onChangedRecipient(
              fromResolved(response, review.recipient.phone),
              response,
              review.recipient.phone,
            );
            throw new Error("This person has joined PingApp. Review the transfer again.");
          }
        } else {
          if (response.status !== "registered") {
            onChangedRecipient(null, response, review.recipient.phone);
            throw new Error("This number no longer points to a wallet. Please review again.");
          }
          const fresh = fromResolved(response, review.recipient.phone, review.recipient.contactId);
          if (recipientChanged(review.recipient, fresh)) {
            onChangedRecipient(fresh, response);
            throw new Error(
              fresh.underReview && !review.recipient.underReview
                ? "Ownership of this number is now under review. Check the phone number and review again."
                : "This recipient's details changed. Check the phone number and review again.",
            );
          }
        }
      }

      // Re-read after all awaited network calls. Bind the request to the signed-in wallet and chain.
      const account = getAccount(wagmiAdapter.wagmiConfig);
      if (!currentAccount(me, expectedRevision) || account.chainId !== chain.id)
        throw new Error("Connect the wallet you signed in with on Robinhood Chain.");
      if (routerSettings.enabled) {
        if (!review.recipient.phone) throw new Error("Enter a recipient phone number.");
        const authorization = await authorize.mutateAsync({
          phone: review.recipient.phone,
          tokenAddress: review.token.address,
          amount: review.amount,
          expectedSenderAddress: me.address,
          expectedRecipientRef: review.recipient.recipientRef ?? null,
          contactId: review.recipient.contactId,
        });
        if (!currentAccount(me, expectedRevision)) throw new Error(sessionChangedMessage);
        if (
          authorization.router.toLowerCase() !== routerSettings.address.toLowerCase() ||
          authorization.auth.sender.toLowerCase() !== me.address.toLowerCase() ||
          authorization.auth.token.toLowerCase() !== review.token.address.toLowerCase() ||
          authorization.auth.amount !== review.amountRaw ||
          authorization.deliveryMode !==
            (review.recipient.kind === "escrow" ? "claim" : "automatic")
        ) {
          throw new Error("The send details changed. Review the recipient and amount again.");
        }
        if (
          authorization.feeWei !== review.router?.escrowFeeWei ||
          authorization.claimTipWei !== review.router?.claimTipWei
        )
          throw new Error("Routing fees changed. Refresh and review again.");
        const client = getPublicClient(wagmiAdapter.wagmiConfig, { chainId: chain.id });
        if (!client) throw new Error("The network connection is unavailable.");
        if (authorization.approval) {
          const approval = authorization.approval;
          if (
            approval.spender.toLowerCase() !== authorization.router.toLowerCase() ||
            approval.token.toLowerCase() !== review.token.address.toLowerCase() ||
            approval.amount !== review.amountRaw
          ) {
            throw new Error("The token approval details changed. Review again.");
          }
          const allowance = await client.readContract({
            address: approval.token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [me.address, authorization.router],
          });
          if (
            !currentAccount(me, expectedRevision) ||
            getAccount(wagmiAdapter.wagmiConfig).chainId !== chain.id
          )
            throw new Error(sessionChangedMessage);
          if (allowance < BigInt(approval.amount)) {
            const approvalHash = await writeContractAsync({
              account: me.address,
              chainId: chain.id,
              address: approval.token,
              abi: erc20Abi,
              functionName: "approve",
              args: [authorization.router, BigInt(approval.amount)],
            });
            const receipt = await client.waitForTransactionReceipt({ hash: approvalHash });
            if (receipt.status !== "success") throw new Error("The token approval failed.");
          }
        }
        if (
          !currentAccount(me, expectedRevision) ||
          getAccount(wagmiAdapter.wagmiConfig).chainId !== chain.id
        )
          throw new Error(sessionChangedMessage);
        const a = authorization.auth;
        const base = {
          id: a.id,
          sender: a.sender,
          token: a.token,
          amount: BigInt(a.amount),
          deadline: BigInt(a.deadline),
        };
        const hash = await writeContractAsync({
          account: me.address,
          chainId: chain.id,
          address: authorization.router,
          abi: pingRouterAbi,
          functionName: "escrow",
          args: [
            { ...base, claimTip: BigInt(a.claimTip), expiresAt: BigInt(a.expiresAt) },
            authorization.signature,
          ],
          value: BigInt(authorization.value),
        });
        const draft: Extract<PendingRecord, { mode: "escrow" }> = {
          sender: me.address,
          mode: "escrow",
          input: {
            txHash: hash,
            expectedSenderAddress: me.address,
            escrowId: authorization.escrowId,
          },
        };
        persist(draft);
        await saveEscrow(draft.input, me, expectedRevision);
      }
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
      if (visiblePending.mode === "escrow")
        await saveEscrow(visiblePending.input, me, expectedRevision);
      else await save(visiblePending.input, me, expectedRevision);
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
    pending: visiblePending?.mode === "escrow" ? null : visiblePending,
    pendingEscrow: visiblePending?.mode === "escrow" ? visiblePending : null,
    escrowId: visibleEscrowId,
    transferId: visibleTransferId,
    recordError:
      visibleRecordError ||
      (visiblePending ? "This transaction still needs to be saved to Activity." : ""),
    busy,
  };
}
