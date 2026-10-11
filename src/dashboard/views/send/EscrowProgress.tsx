import { useEscrows } from "../../../api/hooks";
import type { Address } from "../../../api/types";
import { explorerTx } from "../../../config";

export default function EscrowProgress({
  id,
  pending,
  error,
  busy,
  onRetry,
  onReset,
}: {
  id: string | null;
  pending: { txHash: Address } | null;
  error: string;
  busy: boolean;
  onRetry: () => void;
  onReset: () => void;
}) {
  const query = useEscrows("sent", !!id);
  const escrow = query.data?.find((row) => row.id === id);
  const hash = pending?.txHash ?? escrow?.depositTxHash;
  return (
    <div className="notice" role="status">
      <h3>
        {pending
          ? "Save your submitted escrow"
          : escrow?.status === "deposited"
            ? "Funds are held in escrow"
            : escrow?.status === "claimed"
              ? "Escrow claimed"
              : escrow?.status === "refunded"
                ? "Escrow refunded"
                : escrow?.status === "void"
                  ? "The escrow deposit was not confirmed"
                  : "Confirming your escrow"}
      </h3>
      <p>
        {pending
          ? "Your wallet returned a transaction hash. Retry saving this hash to PingApp; this will not send another transaction."
          : "Track the recipient's claim or refund an expired escrow in Requests."}
      </p>
      {pending && error && <p role="alert">{error}</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
      {hash && (
        <p>
          <a className="text-link" href={explorerTx(hash)} target="_blank" rel="noreferrer">
            View deposit transaction
          </a>
        </p>
      )}
      {pending ? (
        <button className="button accent" disabled={busy} onClick={onRetry}>
          Retry saving escrow
        </button>
      ) : (
        <>
          <a className="button outline" href="/dashboard/requests">
            View requests
          </a>{" "}
          <button className="button accent" onClick={onReset}>
            Send another
          </button>
        </>
      )}
    </div>
  );
}
