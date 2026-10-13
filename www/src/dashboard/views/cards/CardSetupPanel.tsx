import { RefreshCw } from "lucide-react";
import type { CardOperation, CardsConfig, CardSummary } from "@/api/cards";
import type { SetupStage } from "./cardStage";
import { dateTime, usd } from "./format";
import { InvoicePayment } from "./InvoicePayment";

const copy: Record<SetupStage, { title: string; text: string }> = {
  preparing: {
    title: "Preparing your invoice",
    text: "The card provider is creating the setup fee invoice. This usually takes a few seconds.",
  },
  pay: {
    title: "Pay the setup fee",
    text: "Your card is issued automatically once the provider confirms this payment.",
  },
  expired: {
    title: "This invoice expired",
    text: "Do not pay it. We are checking for any late or uncertain payment with the provider. If you already paid, keep the reference below and do not pay again.",
  },
  issuing: {
    title: "Payment received. Issuing your card",
    text: "The provider usually issues the card within a few minutes. You can leave this page; it updates on its own.",
  },
  review: {
    title: "We are checking your payment",
    text: "The provider is confirming this payment. Keep the reference below and do not send another payment.",
  },
  failed: {
    title: "This card was not issued",
    text: "The provider reported a failure. If you sent a payment, contact support with the reference below before paying again.",
  },
  checking: {
    title: "Checking your application",
    text: "Refresh to load the latest status before sending any payment.",
  },
};

type StepState = "done" | "current" | "error" | "todo";

function steps(stage: SetupStage): [StepState, StepState, StepState] {
  switch (stage) {
    case "issuing":
      return ["done", "done", "current"];
    case "failed":
      return ["done", "error", "todo"];
    default:
      return ["done", "current", "todo"];
  }
}

/** A card that is not issued yet: one guided view of its application, payment and issuance. */
export function CardSetupPanel({
  card,
  name,
  stage,
  operation,
  config,
  refreshing,
  refreshError,
  onRefresh,
  onRestart,
}: {
  card: CardSummary;
  name: string;
  stage: SetupStage;
  operation: CardOperation | undefined;
  config: CardsConfig | undefined;
  refreshing: boolean;
  refreshError: boolean;
  onRefresh: () => void;
  onRestart: (() => void) | null;
}) {
  const product = config?.products.find((item) => item.id === card.product);
  const fee = operation?.invoice?.amountUsd ?? product?.issuePriceUsd ?? null;
  const [applied, paid, issued] = steps(stage);
  const message = copy[stage];
  return (
    <section className="cs-panel" aria-labelledby="cs-title">
      <ol className="cs-steps" aria-label="Card setup progress">
        <li data-state={applied}>Applied</li>
        <li data-state={paid} aria-current={paid === "current" ? "step" : undefined}>
          Pay setup fee
        </li>
        <li data-state={issued} aria-current={issued === "current" ? "step" : undefined}>
          Card issued
        </li>
      </ol>
      <div className="cs-body">
        <div className="cs-main" role="status">
          <h2 id="cs-title">{message.title}</h2>
          <p className="cs-text">{message.text}</p>
          {stage === "pay" && operation && <InvoicePayment operation={operation} config={config} />}
          {stage === "issuing" && (
            <p className="cs-pulse">
              <span aria-hidden="true" /> Waiting for the card provider
            </p>
          )}
          {operation?.error && (
            <p className="card-error" role="alert">
              {operation.error}
            </p>
          )}
          {refreshError && (
            <p className="card-error" role="alert">
              Could not refresh. The last known status is shown.
            </p>
          )}
          {stage === "failed" && onRestart && (
            <button type="button" className="button accent" onClick={onRestart}>
              Start a new application
            </button>
          )}
        </div>
        <aside className="cs-side" aria-label="Application details">
          <dl className="cs-facts">
            <div>
              <dt>Card</dt>
              <dd>{name}</dd>
            </div>
            <div>
              <dt>Setup fee</dt>
              <dd>{fee != null ? usd(fee) : "On invoice"}</dd>
            </div>
            <div>
              <dt>Applied</dt>
              <dd>{dateTime(card.createdAt)}</dd>
            </div>
            {operation && (
              <div>
                <dt>Reference</dt>
                <dd className="cs-ref">{operation.id}</dd>
              </div>
            )}
          </dl>
          {stage !== "failed" && (
            <div className="cs-next">
              <h3>Once it&apos;s issued</h3>
              <ul>
                <li>Add funds with USDT</li>
                <li>See the card number to pay online</li>
                {card.product === "mastercard" && <li>Add it to Apple Pay</li>}
              </ul>
            </div>
          )}
          <button
            type="button"
            className="button outline"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw size={15} className={refreshing ? "spin" : undefined} />
            {refreshing ? "Checking…" : "Refresh status"}
          </button>
        </aside>
      </div>
    </section>
  );
}
