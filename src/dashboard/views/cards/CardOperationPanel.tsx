import { useEffect, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import type { CardOperation, CardsConfig } from "@/api/cards";
import { copyText, dateTime, usd } from "./format";

const messages: Record<CardOperation["status"], { title: string; text: string }> = {
  created: {
    title: "Request received",
    text: "Your invoice is being prepared. You can leave this page and return to this request.",
  },
  submitting: {
    title: "Preparing invoice",
    text: "Waiting for the provider. Please keep this request; do not create or pay another invoice.",
  },
  awaiting_payment: {
    title: "Awaiting payment",
    text: "An invoice is ready. Card issuance or credit is confirmed separately after payment.",
  },
  processing: {
    title: "Processing",
    text: "The provider is processing this request. Do not send another payment.",
  },
  completed: {
    title: "Completed",
    text: "The provider confirmed this operation. The card balance and status below refresh separately.",
  },
  failed: {
    title: "Request failed",
    text: "The provider reported a failure. If you sent a payment, contact support before paying again.",
  },
  expired: {
    title: "Invoice expired",
    text: "Do not pay this invoice. We are checking any late or uncertain payment with the provider. Expiry does not cancel your card request.",
  },
  review: {
    title: "Under review",
    text: "We are checking the payment with the provider. Keep this request reference and do not send another payment.",
  },
};

export function CardOperationPanel({
  operation,
  refreshing,
  refreshError,
  onRefresh,
  cardLabel,
  config,
}: {
  operation: CardOperation;
  refreshing: boolean;
  refreshError: boolean;
  onRefresh: () => void;
  cardLabel: string;
  config: CardsConfig | undefined;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const invoice = operation.invoice;
  const expired = Boolean(invoice?.expiresAt && Date.parse(invoice.expiresAt) <= now);
  const payable = operation.status === "awaiting_payment" && !expired && config !== undefined;
  const network = config?.networks.find((item) => item.id === invoice?.network);
  let invoiceUrl: string | null = null;
  try {
    const url = new URL(invoice?.url ?? "");
    if (url.protocol === "https:" && !url.username && !url.password) invoiceUrl = url.href;
  } catch {
    /* Missing/invalid provider URL is not actionable. */
  }
  const message = messages[operation.status] ?? {
    title: "Status unavailable",
    text: "Refresh to check this request before making a payment.",
  };
  async function copy(value: string) {
    try {
      await copyText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy was unavailable. Select the value to copy it.");
    }
  }

  if (operation.status === "completed") {
    if (operation.kind === "issue") return null;
    return (
      <p className="card-topup-confirmation" role="status">
        <strong>{config?.sandbox ? "Sandbox test credit confirmed" : "Top-up confirmed"}</strong>
        <span>
          {cardLabel}
          {config?.sandbox
            ? " · Simulated funds; no real payment."
            : " · The provider confirmed this credit."}
        </span>
      </p>
    );
  }

  return (
    <section
      className="card card-operation"
      aria-label={`${operation.kind === "issue" ? "Card application" : "Top-up"} status`}
    >
      <div className="panel-heading">
        <h2>{operation.kind === "issue" ? "Card application" : "Top-up"}</h2>
        <span className="field-help">{cardLabel}</span>
      </div>
      <div role="status">
        <strong>{message.title}</strong>
        <p className="field-help">{message.text}</p>
      </div>
      {operation.error && (
        <p className="card-error" role="alert">
          {operation.error}
        </p>
      )}
      {refreshError && (
        <p className="card-error" role="alert">
          Could not refresh this request. The last known status is shown.
        </p>
      )}
      {config?.sandbox && (
        <p className="card-sandbox">
          Sandbox testing only. These are test payment instructions. Do not send real money.
        </p>
      )}
      {invoice && (
        <div className="card-invoice">
          <dl className="card-invoice-values">
            <div>
              <dt>Asset / network</dt>
              <dd>USDT · {network?.label ?? invoice.network}</dd>
            </div>
            <div>
              <dt>Exact crypto quantity</dt>
              <dd>
                {invoice.amount ?? "Not supplied"} {invoice.amount ? "USDT" : ""}
              </dd>
            </div>
            <div>
              <dt>You pay (USD)</dt>
              <dd>{usd(invoice.amountUsd)}</dd>
            </div>
            <div>
              <dt>Added to card</dt>
              <dd>{usd(invoice.amountOnCardUsd)}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{invoice.expiresAt ? dateTime(invoice.expiresAt) : "Not supplied"}</dd>
            </div>
          </dl>
          <p className="field-help">
            The provider sets the exact crypto amount. Fees and net card credit are unknown unless
            shown above.
          </p>
          {expired && operation.status === "awaiting_payment" && (
            <p className="card-error" role="alert">
              The displayed expiry has passed. Do not pay while the provider confirms the outcome.
            </p>
          )}
          {payable && invoice.address && invoice.amount ? (
            <>
              <div className="card-invoice-qr">
                <QRCodeSVG
                  value={invoice.address}
                  size={164}
                  marginSize={2}
                  title="Invoice payment address"
                />
              </div>
              <p className="field-help">
                {config?.sandbox
                  ? "Test invoice address"
                  : "Send only the exact USDT quantity on the network above. The QR contains the address only."}
              </p>
              <code className="card-invoice-address">{invoice.address}</code>
              <div className="card-form-actions">
                <button
                  className="button outline"
                  type="button"
                  onClick={() => void copy(invoice.address!)}
                >
                  <Copy size={15} /> Copy address
                </button>
                <button
                  className="button outline"
                  type="button"
                  onClick={() => void copy(invoice.amount!)}
                >
                  <Copy size={15} /> Copy quantity
                </button>
              </div>
            </>
          ) : (
            operation.status === "awaiting_payment" &&
            !expired && (
              <p className="field-help">
                Complete payment instructions are not available yet. Refresh before sending
                anything.
              </p>
            )
          )}
          {payable && invoiceUrl && (
            <a
              className="button outline"
              href={invoiceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {config?.sandbox ? "Open test invoice" : "Open provider invoice"}{" "}
              <ExternalLink size={15} />
            </a>
          )}
        </div>
      )}
      <div className="card-operation-footer">
        <small>
          Request reference: <span>{operation.id}</span>
        </small>
        <button type="button" className="button outline" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? "Checking…" : "Refresh status"}
        </button>
      </div>
    </section>
  );
}
