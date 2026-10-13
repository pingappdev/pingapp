import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatEther, parseEventLogs } from "viem";
import { getAccount, getPublicClient } from "wagmi/actions";
import { useSwitchChain, useWriteContract } from "wagmi";
import { toast } from "sonner";
import { endpoints } from "../../../api/client";
import { qk, sessionRevision, useClaimEscrow, useConfig, useEscrows } from "../../../api/hooks";
import type { Escrow, Me } from "../../../api/types";
import { useAuth } from "../../../auth/useAuth";
import { chain, explorerTx } from "../../../config";
import { wagmiAdapter } from "../../../wallet/appkit";
import { pingRouterAbi } from "../../../wallet/pingRouterAbi";
import TokenIcon from "../../components/TokenIcon";
import { errorMessage } from "../send/errors";
import { QueryMessage } from "./IntentRows";
import OwedRefund from "./OwedRefund";
import { owedRefundKey } from "./utils";

const labels: Record<Escrow["status"], string> = {
  authorized: "Awaiting deposit",
  deposited: "Held in escrow",
  claiming: "Claiming…",
  claimed: "Claimed",
  refunded: "Refunded",
  void: "Not deposited",
};

export default function EscrowLists() {
  const config = useConfig();
  const enabled = !!config.data?.router.enabled;
  const sent = useEscrows("sent", enabled);
  const incoming = useEscrows("incoming", enabled);
  const claim = useClaimEscrow();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refundHashes, setRefundHashes] = useState<Record<string, `0x${string}`>>({});
  const running = useRef(false);
  if (!enabled) return null;

  async function act(row: Escrow, action: "claim" | "selfClaim" | "refund") {
    if (running.current || !auth.me) return;
    running.current = true;
    setBusyId(row.id);
    const expected = auth.me;
    const revision = sessionRevision(queryClient);
    const current = () => {
      const me = queryClient.getQueryData<Me | null>(qk.session);
      const account = getAccount(wagmiAdapter.wagmiConfig);
      return (
        sessionRevision(queryClient) === revision &&
        me?.id === expected.id &&
        account.isConnected &&
        me.address.toLowerCase() === expected.address.toLowerCase() &&
        account.address?.toLowerCase() === expected.address.toLowerCase()
      );
    };
    try {
      if (!current()) throw new Error("Connect the wallet you signed in with.");
      if (action === "claim") {
        await claim.mutateAsync(row.id);
        if (current()) toast.success("Claim requested. The relayer pays the network fee.");
      } else {
        if (getAccount(wagmiAdapter.wagmiConfig).chainId !== chain.id)
          await switchChainAsync({ chainId: chain.id });
        if (!current()) throw new Error("Your wallet or session changed.");
        const address = config.data?.router.address;
        if (!address) throw new Error("The router address is unavailable.");
        const client = getPublicClient(wagmiAdapter.wagmiConfig, { chainId: chain.id });
        if (!client) throw new Error("The network connection is unavailable.");
        if (action === "selfClaim") {
          // The signed claim pays only this wallet; it also submits it and receives the tip.
          const { claim: signed } = await endpoints.escrows.selfClaim(row.id);
          if (
            signed.router.toLowerCase() !== address.toLowerCase() ||
            signed.auth.recipient.toLowerCase() !== expected.address.toLowerCase() ||
            signed.auth.relayer.toLowerCase() !== expected.address.toLowerCase()
          )
            throw new Error("The claim authorization does not match this wallet.");
          if (!current()) throw new Error("Your wallet or session changed.");
          const hash = await writeContractAsync({
            account: expected.address,
            chainId: chain.id,
            address,
            abi: pingRouterAbi,
            functionName: "claim",
            args: [{ ...signed.auth, deadline: BigInt(signed.auth.deadline) }, signed.signature],
          });
          const receipt = await client.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error("The claim transaction failed.");
          if (current()) {
            toast.success("Claim confirmed. The funds are in your wallet.");
            void queryClient.invalidateQueries({ queryKey: qk.escrowsPrefix });
            void queryClient.invalidateQueries({ queryKey: qk.balancesPrefix });
          }
          return;
        }
        // This transaction has no PingApp API dependency. The contract always refunds the original sender.
        const hash = await writeContractAsync({
          account: expected.address,
          chainId: chain.id,
          address,
          abi: pingRouterAbi,
          functionName: "refund",
          args: [row.id],
        });
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("The refund transaction failed.");
        if (current()) {
          setRefundHashes((previous) => ({ ...previous, [row.id]: hash }));
          const credited = parseEventLogs({
            abi: pingRouterAbi,
            eventName: "EthCredited",
            logs: receipt.logs,
          });
          if (credited.length) {
            toast.success(
              "Refund confirmed. This wallet rejected ETH, so the ETH part is held for withdrawal below.",
            );
            void queryClient.invalidateQueries({
              queryKey: owedRefundKey(address, expected.address),
            });
          } else {
            toast.success("Refund confirmed. The principal and claim tip returned to the sender.");
          }
          void queryClient.invalidateQueries({ queryKey: qk.escrowsPrefix });
          void queryClient.invalidateQueries({ queryKey: qk.balancesPrefix });
        }
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      running.current = false;
      setBusyId(null);
    }
  }

  return (
    <>
      {config.data?.router.address && auth.me && (
        <OwedRefund router={config.data.router.address} account={auth.me.address} />
      )}
      {(
        [
          { role: "sent", title: "Sent escrows", query: sent },
          { role: "incoming", title: "Incoming escrows", query: incoming },
        ] as const
      ).map(({ role, title, query }) => (
        <section className="card request-list-card" key={role}>
          <div className="panel-heading">
            <div>
              <h2>{title}</h2>
              <p className="field-help">
                {role === "sent"
                  ? "Funds are held until claimed. After expiry, refund the principal and unused claim tip."
                  : "Claim to your signed-in wallet. You do not need ETH for the network fee."}
              </p>
            </div>
          </div>
          {(query.isPending || query.error) && (
            <QueryMessage
              title={title}
              loading={query.isPending}
              error={query.error}
              onRetry={() => void query.refetch()}
            />
          )}
          {!query.isPending && !query.error && !query.data?.length && (
            <p className="request-empty">No {title.toLowerCase()} yet.</p>
          )}
          <div className="request-intent-list">
            {query.data?.map((row) => (
              <article className="request-intent-row" key={row.id}>
                <div className="request-intent-main">
                  <TokenIcon symbol={row.token.symbol} logoUrl={row.token.logoUrl} />
                  <div>
                    <strong>
                      {row.amount} {row.token.symbol}
                      {role === "sent"
                        ? ` · ${row.recipientPhoneMasked}`
                        : ` from ${row.sender.displayName}`}
                    </strong>
                    <small>Expires {new Date(row.expiresAt).toLocaleString()}</small>
                    {role === "sent" && (
                      <small>
                        {row.deliveryMode === "automatic" ? "Routing" : "SMS"} fee{" "}
                        {formatEther(BigInt(row.feeWei))} ETH · relay tip{" "}
                        {formatEther(BigInt(row.claimTipWei))} ETH
                      </small>
                    )}
                  </div>
                </div>
                <div className="request-intent-actions">
                  <span className="pill">
                    {refundHashes[row.id]
                      ? "Refunded"
                      : row.selfClaim && row.status === "deposited"
                        ? "Claim needed"
                        : row.deliveryMode === "automatic" && row.status === "claimed"
                          ? "Delivered"
                          : row.deliveryMode === "automatic" &&
                              ["deposited", "claiming"].includes(row.status)
                            ? "Delivery pending"
                            : labels[row.status]}
                  </span>
                  {role === "incoming" &&
                    row.deliveryMode === "claim" &&
                    !row.selfClaim &&
                    row.status === "deposited" &&
                    !row.refundable && (
                      <button
                        className="button accent"
                        disabled={!!busyId}
                        onClick={() => void act(row, "claim")}
                      >
                        {busyId === row.id ? "Requesting…" : "Claim"}
                      </button>
                    )}
                  {role === "incoming" &&
                    row.selfClaim &&
                    row.status === "deposited" &&
                    !row.refundable && (
                      <button
                        className="button accent"
                        disabled={!!busyId}
                        title="This payout needs more gas than PingApp's relayer covers."
                        onClick={() => void act(row, "selfClaim")}
                      >
                        {busyId === row.id ? "Claiming…" : "Claim (you pay gas)"}
                      </button>
                    )}
                  {role === "sent" &&
                    !refundHashes[row.id] &&
                    (row.refundable ||
                      (row.status === "deposited" && Date.parse(row.expiresAt) <= Date.now())) && (
                      <button
                        className="button accent"
                        disabled={!!busyId}
                        onClick={() => void act(row, "refund")}
                      >
                        {busyId === row.id ? "Refunding…" : "Refund"}
                      </button>
                    )}
                  {(refundHashes[row.id] ||
                    row.refundTxHash ||
                    row.claimTxHash ||
                    row.depositTxHash) && (
                    <a
                      className="text-link"
                      target="_blank"
                      rel="noreferrer"
                      href={explorerTx(
                        refundHashes[row.id] ||
                          row.refundTxHash ||
                          row.claimTxHash ||
                          row.depositTxHash!,
                      )}
                    >
                      View transaction
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
