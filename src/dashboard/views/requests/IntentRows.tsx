import {
  AlertCircle,
  ArrowUpRight,
  Clock3,
  Copy,
  Hourglass,
  LoaderCircle,
  Share2,
  Users,
} from "lucide-react";
import type { IncomingIntent, Intent } from "../../../api/types";
import { trimAddress } from "../../format";
import TokenIcon from "../../components/TokenIcon";
import { daysUntil, shareInvite, copyInvite } from "./utils";

export function IntentCard({
  intent,
  onCancel,
  canceling,
  readOnly = false,
}: {
  intent: Intent;
  onCancel: (intent: Intent) => void;
  canceling: boolean;
  readOnly?: boolean;
}) {
  const ready = intent.status === "ready";
  const recipient = intent.recipient;
  const name = recipient?.displayName || "PingApp recipient";

  return (
    <article className="request-intent-row">
      <div className="request-intent-main">
        <TokenIcon symbol={intent.token.symbol} logoUrl={intent.token.logoUrl} />
        <div>
          <strong>
            {intent.amount} {intent.token.symbol}
            {ready ? ` to ${name}` : " pending"}
          </strong>
          <small>
            {ready && recipient
              ? `${trimAddress(recipient.address)} · `
              : `${intent.recipientPhoneMasked} · `}
            {ready ? "Ready to send" : `Expires in ${daysUntil(intent.expiresAt)} days`}
          </small>
        </div>
      </div>
      <div className="request-intent-actions">
        {ready && !readOnly ? (
          <a
            className="button accent"
            href={`/dashboard/send?intent=${encodeURIComponent(intent.id)}`}
          >
            Complete send <ArrowUpRight size={15} />
          </a>
        ) : (
          <>
            <button
              className="button outline"
              type="button"
              onClick={() => void copyInvite(intent.claimUrl)}
            >
              <Copy size={14} /> Copy invite link
            </button>
            {typeof navigator !== "undefined" && typeof navigator.share === "function" && (
              <button
                className="button outline"
                type="button"
                onClick={() => void shareInvite(intent)}
              >
                <Share2 size={14} /> Share
              </button>
            )}
          </>
        )}
        <button
          className="request-cancel-button"
          type="button"
          disabled={canceling}
          onClick={() => onCancel(intent)}
        >
          {canceling ? "Canceling…" : "Cancel"}
        </button>
      </div>
    </article>
  );
}

export function IncomingIntentRow({ intent }: { intent: IncomingIntent }) {
  return (
    <article className="request-intent-row">
      <div className="request-intent-main">
        <span className="contact-initial">
          {intent.sender.displayName.slice(0, 1).toUpperCase() || "?"}
        </span>
        <div>
          <strong>
            {intent.sender.displayName} wants to send you {intent.amount} {intent.token.symbol}
          </strong>
          <small>
            {intent.status === "ready" ? "They've been notified you're ready." : "Sent ✓"}
          </small>
        </div>
      </div>
      <span className={`pill status-pill status-${intent.status}`}>
        {intent.status === "ready" ? "Ready to send" : "Completed"}
      </span>
    </article>
  );
}

export function QueryMessage({
  title,
  loading,
  error,
  onRetry,
}: {
  title: string;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="request-query-message" role={loading ? "status" : "alert"}>
      {loading ? <LoaderCircle size={16} className="spin" /> : <AlertCircle size={16} />}
      <span>
        {loading ? `Loading ${title.toLowerCase()}…` : `Couldn't load ${title.toLowerCase()}.`}
      </span>
      {!loading && (
        <button type="button" className="text-link" onClick={onRetry}>
          Try again
        </button>
      )}
      {!loading && error instanceof Error && <small>{error.message}</small>}
    </div>
  );
}

export function EmptyIntents({ kind }: { kind: "ready" | "pending" | "incoming" }) {
  if (kind === "ready")
    return (
      <p className="request-empty">
        <Clock3 size={17} /> No pending sends are ready yet.
      </p>
    );
  if (kind === "pending")
    return (
      <p className="request-empty">
        <Hourglass size={17} /> No one is waiting to link a wallet.
      </p>
    );
  return (
    <p className="request-empty">
      <Users size={17} /> No pending sends are addressed to your linked number.
    </p>
  );
}
