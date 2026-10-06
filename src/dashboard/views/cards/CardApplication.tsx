import { useEffect, useState, type FormEvent } from "react";
import { cardsApi, type CardsConfig, type CardNetwork } from "@/api/cards";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { usd } from "./format";

export function CardApplication({
  config,
  kind,
  busy,
  available,
  error,
  onClose,
  onSubmit,
}: {
  config: CardsConfig;
  kind: "issue" | "topup";
  busy: boolean;
  available: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: { email: string; network: CardNetwork; amountUsd: string }) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [network, setNetwork] = useState<CardNetwork | "">(config.networks[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(kind === "issue");
  const [profileError, setProfileError] = useState(false);
  const product = config.products.find((item) => item.id === "visa");
  useEffect(() => {
    if (kind !== "issue") return;
    const controller = new AbortController();
    void cardsApi
      .profile({ signal: controller.signal })
      .then(({ profile }) => {
        if (!controller.signal.aborted) setEmail(profile?.email ?? "");
      })
      .catch(() => {
        if (!controller.signal.aborted) setProfileError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingProfile(false);
      });
    return () => controller.abort();
  }, [kind]);

  const validAmount = /^\d+(\.\d{1,2})?$/.test(amount) && /[1-9]/.test(amount);
  const validNetwork = config.networks.some((item) => item.id === network);
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const valid =
    validNetwork && (kind === "issue" ? validEmail && confirmed && Boolean(product) : validAmount);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || busy || !available) return;
    const trimmed = email.trim();
    const at = trimmed.lastIndexOf("@");
    const normalized = trimmed.slice(0, at) + "@" + trimmed.slice(at + 1).toLowerCase();
    const [whole, fraction = ""] = amount.split(".");
    await onSubmit({
      email: normalized,
      network: network as CardNetwork,
      amountUsd: `${whole.replace(/^0+(?=\d)/, "")}.${fraction.padEnd(2, "0")}`,
    });
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="ping-dialog card-dialog">
        <DialogTitle>{kind === "issue" ? "Create your card" : "Top up your card"}</DialogTitle>
        <DialogDescription>
          {kind === "issue"
            ? "Add a contact email for this card application. You can cancel and keep using PingApp."
            : config.sandbox
              ? "Request a test top-up. The provider may simulate credit immediately without an invoice. No real payment is needed."
              : "Request a provider invoice in USDT. Funds are added to your card only after the provider confirms credit."}
        </DialogDescription>
        {config.sandbox && (
          <p className="card-sandbox">
            Sandbox testing only. Do not send real money to test invoices.
          </p>
        )}
        <form className="card-application" onSubmit={submit}>
          {kind === "issue" ? (
            <>
              <label className="card-field">
                Contact email
                <input
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={email}
                  disabled={busy || loadingProfile}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setConfirmed(false);
                  }}
                  placeholder={loadingProfile ? "Loading saved email…" : "you@example.com"}
                />
              </label>
              {profileError && (
                <p className="field-help">
                  Saved email could not be loaded. Enter the email you want to use for this
                  application.
                </p>
              )}
              <label className="card-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>
                  I confirm this is the contact email to share with the card provider for this
                  application.
                </span>
              </label>
              <div className="card-info-row">
                <span>{product?.name ?? "Visa"} issue price</span>
                <strong>
                  {product?.issuePriceUsd != null
                    ? usd(product.issuePriceUsd)
                    : "Available on invoice"}
                </strong>
              </div>
              <p className="field-help">
                Creating an invoice does not issue the card. Funding the issued card is a separate
                top-up.
              </p>
            </>
          ) : (
            <>
              <label className="card-field">
                You pay (USD)
                <input
                  inputMode="decimal"
                  required
                  value={amount}
                  disabled={busy}
                  placeholder="0.00"
                  maxLength={20}
                  onChange={(event) => {
                    if (/^\d*(\.\d{0,2})?$/.test(event.target.value)) setAmount(event.target.value);
                  }}
                />
              </label>
              <p className="field-help">
                The invoice will show the exact USDT quantity to pay and the amount added to your
                card, when the provider supplies it.
              </p>
            </>
          )}
          <label className="card-field">
            USDT network
            <select
              required
              value={network}
              disabled={busy}
              onChange={(event) => setNetwork(event.target.value as CardNetwork)}
            >
              {config.networks.map((item) => (
                <option key={item.id} value={item.id}>
                  USDT · {item.label}
                </option>
              ))}
            </select>
          </label>
          {!config.networks.length && (
            <p className="card-error">No payment networks are currently available.</p>
          )}
          {error && (
            <p role="alert" className="card-error">
              {error}
            </p>
          )}
          <div className="card-form-actions">
            <button type="button" className="button outline" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="button accent"
              disabled={!valid || busy || !available || !config.enabled}
            >
              {busy
                ? "Requesting invoice…"
                : config.sandbox
                  ? kind === "topup"
                    ? "Request test top-up"
                    : "Request test invoice"
                  : "Request invoice"}
            </button>
          </div>
          {!available && !busy && (
            <p role="status" className="field-help">
              Invoices are unavailable or another request is pending. Close this window to review
              your card status.
            </p>
          )}
          {busy && (
            <p className="field-help" role="status">
              You may close this window. A submitted request remains recoverable from the card
              screen.
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
