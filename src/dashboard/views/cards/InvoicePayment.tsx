import { useEffect, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import type { CardOperation, CardsConfig } from "@/api/cards";
import { copyText, dateTime, usd } from "./format";

function timeLeft(expiresAt: string, now: number): string | null {
  const minutes = Math.floor((Date.parse(expiresAt) - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min left` : `${Math.floor(hours / 24)} days left`;
}

/** Payment instructions for one provider invoice: the exact amount first, then where to send it. */
export function InvoicePayment({
  operation,
  config,
}: {
  operation: CardOperation;
  config: CardsConfig | undefined;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const invoice = operation.invoice;
  if (!invoice) return null;
  const expired = Boolean(invoice.expiresAt && Date.parse(invoice.expiresAt) <= now);
  const payable = operation.status === "awaiting_payment" && !expired && config !== undefined;
  const network =
    config?.networks.find((item) => item.id === invoice.network)?.label ?? invoice.network;
  let invoiceUrl: string | null = null;
  try {
    const url = new URL(invoice.url ?? "");
    if (url.protocol === "https:" && !url.username && !url.password) invoiceUrl = url.href;
  } catch {
    /* Missing/invalid provider URL is not actionable. */
  }
  async function copy(value: string) {
    try {
      await copyText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy was unavailable. Select the value to copy it.");
    }
  }

  if (!payable) {
    if (operation.status !== "awaiting_payment") return null;
    return expired ? (
      <p className="card-error" role="alert">
        This invoice&apos;s expiry has passed. Do not pay it while the provider confirms the
        outcome.
      </p>
    ) : (
      <p className="field-help">
        Payment instructions are not available yet. Refresh before sending anything.
      </p>
    );
  }
  const complete = Boolean(invoice.address && invoice.amount);
  return (
    <div className="pay-block">
      <div className="pay-amount">
        <span>Send exactly</span>
        <strong>{invoice.amount ? `${invoice.amount} USDT` : usd(invoice.amountUsd)}</strong>
        <small>
          on {network}
          {invoice.amount ? ` · ${usd(invoice.amountUsd)}` : ""}
          {operation.kind === "topup" && invoice.amountOnCardUsd
            ? ` · ${usd(invoice.amountOnCardUsd)} added to card`
            : ""}
        </small>
      </div>
      {complete ? (
        <div className="pay-target">
          <div className="pay-qr">
            <QRCodeSVG value={invoice.address!} size={148} marginSize={2} title="Payment address" />
          </div>
          <div className="pay-address">
            <span>{config?.sandbox ? "Test payment address" : `USDT address on ${network}`}</span>
            <code>{invoice.address}</code>
            <div className="pay-copy">
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
                <Copy size={15} /> Copy amount
              </button>
            </div>
          </div>
        </div>
      ) : (
        <p className="field-help">
          Payment instructions are not complete yet. Refresh before sending anything.
        </p>
      )}
      <div className="pay-meta">
        {invoice.expiresAt && (
          <span>
            Pay by {dateTime(invoice.expiresAt)}
            {timeLeft(invoice.expiresAt, now) ? ` · ${timeLeft(invoice.expiresAt, now)}` : ""}
          </span>
        )}
        {invoiceUrl && (
          <a className="text-link" href={invoiceUrl} target="_blank" rel="noopener noreferrer">
            {config?.sandbox ? "Open test invoice" : "Open provider invoice"}{" "}
            <ExternalLink size={14} />
          </a>
        )}
      </div>
      <p className="pay-warning">
        {config?.sandbox
          ? "Sandbox: these are test instructions. Do not send real money."
          : "Send only USDT on this network, in one payment of the exact amount. The QR code holds the address only."}
      </p>
    </div>
  );
}
