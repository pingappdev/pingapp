import { Check, ExternalLink, LoaderCircle, XCircle } from "lucide-react";
import { useTransfer } from "../../../api/hooks";
import { explorerTx } from "../../../config";
import type { TransferCreateInput } from "../../../api/types";

export default function TransferProgress({
  transferId,
  pending,
  recordError,
  retryRecord,
  busy,
  onReset,
}: {
  transferId: string | null;
  pending: TransferCreateInput | null;
  recordError: string;
  retryRecord: () => void;
  busy: boolean;
  onReset: () => void;
}) {
  const query = useTransfer(transferId ?? undefined);
  if (pending)
    return (
      <div className="transaction-result" role="status">
        <h3>The transfer was submitted on-chain</h3>
        <p>
          PingApp couldn&apos;t save it to Activity. The wallet request has already happened;
          retrying only saves this transaction.
        </p>
        <p className="send-error">{recordError || "Saving the transfer…"}</p>
        <code className="send-hash">{pending.txHash}</code>
        <a href={explorerTx(pending.txHash)} target="_blank" rel="noreferrer">
          View transaction <ExternalLink size={15} />
        </a>
        <button type="button" onClick={retryRecord} disabled={busy}>
          {busy ? "Saving…" : "Save to activity"}
        </button>
      </div>
    );
  if (!transferId) return null;
  const transfer = query.data;
  const status = transfer?.status ?? "submitted";
  return (
    <div className="transaction-result" role="status">
      {status === "submitted" ? (
        <LoaderCircle className="spin" />
      ) : status === "confirmed" ? (
        <Check />
      ) : (
        <XCircle />
      )}
      <h3>
        {status === "submitted"
          ? "Waiting for confirmation…"
          : status === "confirmed"
            ? `Sent ${transfer?.amount} ${transfer?.token.symbol} to ${transfer?.to.displayName || transfer?.contactName || transfer?.to.address}`
            : status === "failed"
              ? "The transfer failed"
              : status === "unverified"
                ? "Mined, but we couldn't match the details. Check the explorer."
                : "We couldn't find this transaction. Check your wallet's activity."}
      </h3>
      {query.isError && <p>We couldn&apos;t refresh its status. Check the explorer or Activity.</p>}
      {transfer && (
        <a
          href={transfer.explorerUrl || explorerTx(transfer.txHash)}
          target="_blank"
          rel="noreferrer"
        >
          View transaction <ExternalLink size={15} />
        </a>
      )}
      <a href="/dashboard/activity">View activity</a>
      {status === "confirmed" && (
        <button type="button" onClick={onReset}>
          Send another
        </button>
      )}
    </div>
  );
}
