import type { CardOperation, CardsConfig } from "@/api/cards";
import { InvoicePayment } from "./InvoicePayment";

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
    text: "Pay the invoice below. Funds are added once the provider confirms the payment.",
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
  const message = messages[operation.status] ?? {
    title: "Status unavailable",
    text: "Refresh to check this request before making a payment.",
  };
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
      data-kind={operation.kind}
    >
      <div className="panel-heading">
        <h2>{operation.kind === "issue" ? "Card application" : "Top-up"}</h2>
        {cardLabel && <span className="field-help">{cardLabel}</span>}
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
      <InvoicePayment operation={operation} config={config} />
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
