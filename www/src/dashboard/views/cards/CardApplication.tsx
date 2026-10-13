import { useEffect, useState, type FormEvent } from "react";
import { cardsApi, type CardsConfig, type CardNetwork, type CardProductId } from "@/api/cards";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { CardFace } from "./CardFace";
import { usd } from "./format";

export function CardApplication({
  config,
  kind,
  busy,
  available,
  error,
  ownedProducts,
  onClose,
  onSubmit,
}: {
  config: CardsConfig;
  kind: "issue" | "topup";
  busy: boolean;
  available: boolean;
  error: string | null;
  ownedProducts: string[];
  onClose: () => void;
  onSubmit: (input: {
    email: string;
    cardholderName: string | null;
    product: CardProductId;
    network: CardNetwork;
    amountUsd: string;
  }) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [cardholderName, setCardholderName] = useState("");
  const [productId, setProductId] = useState<CardProductId>(
    config.products.find((item) => !ownedProducts.includes(item.id))?.id ??
      config.products[0]?.id ??
      "visa",
  );
  const [network, setNetwork] = useState<CardNetwork | "">(config.networks[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(kind === "issue");
  const [profileError, setProfileError] = useState(false);
  const product = config.products.find((item) => item.id === productId);
  useEffect(() => {
    if (kind !== "issue") return;
    const controller = new AbortController();
    void cardsApi
      .profile({ signal: controller.signal })
      .then(({ profile }) => {
        if (!controller.signal.aborted) {
          setEmail(profile?.email ?? "");
          setCardholderName(profile?.cardholderName ?? "");
        }
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
    validNetwork &&
    (kind === "issue"
      ? validEmail &&
        confirmed &&
        Boolean(product) &&
        !ownedProducts.includes(productId) &&
        cardholderName.trim().length <= 100
      : validAmount);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || busy || !available) return;
    const trimmed = email.trim();
    const at = trimmed.lastIndexOf("@");
    const normalized = trimmed.slice(0, at) + "@" + trimmed.slice(at + 1).toLowerCase();
    const [whole, fraction = ""] = amount.split(".");
    await onSubmit({
      email: normalized,
      cardholderName: cardholderName.trim() || null,
      product: productId,
      network: network as CardNetwork,
      amountUsd: `${whole.replace(/^0+(?=\d)/, "")}.${fraction.padEnd(2, "0")}`,
    });
  }
  const networkPicker = (
    <fieldset className="pc-picker" disabled={busy}>
      <legend>Pay with USDT on</legend>
      <div className="pc-chips">
        {config.networks.map((item) => (
          <label key={item.id} className="pc-chip-option">
            <input
              type="radio"
              name="card-network"
              value={item.id}
              required
              checked={network === item.id}
              onChange={() => setNetwork(item.id)}
            />
            <span>{item.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className={`ping-dialog card-dialog${kind === "issue" ? " card-dialog-wide" : " card-dialog-topup"}`}
      >
        <DialogTitle>{kind === "issue" ? "Create your card" : "Top up your card"}</DialogTitle>
        <DialogDescription>
          {kind === "issue"
            ? "Choose a card type and the contact email the card provider should use."
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
            <div className="cd-layout">
              <aside className="cd-preview" aria-label="Selected card">
                <CardFace
                  product={productId}
                  name={cardholderName.trim() || "Your name"}
                  network={product?.network ?? "visa"}
                />
                <div className="cd-preview-meta">
                  <strong>{product?.name ?? "Card"}</strong>
                  <span>
                    {product?.issuePriceUsd != null
                      ? `${usd(product.issuePriceUsd)} to issue`
                      : "Price shown on the invoice"}
                  </span>
                </div>
                {product?.description && <p className="cd-preview-text">{product.description}</p>}
                {productId === "mastercard" && (
                  <p className="cd-preview-note" role="note">
                    {config.capabilities.applePay
                      ? "Works with Apple Pay. Once the card is issued, choose Add to Apple Pay on it to get the activation code."
                      : "Works with Apple Pay on live cards. Apple Pay activation is not available in sandbox."}
                  </p>
                )}
                <p className="cd-preview-text">
                  You can add funds once the card is issued. The card provider does not fund a card
                  while creating it.
                </p>
              </aside>
              <div className="cd-fields">
                <fieldset className="pc-picker" disabled={busy}>
                  <legend>Card type</legend>
                  <div className="pc-picker-grid">
                    {config.products.map((item) => {
                      const owned = ownedProducts.includes(item.id);
                      return (
                        <label key={item.id} className="pc-option" data-owned={owned || undefined}>
                          <input
                            type="radio"
                            name="card-product"
                            value={item.id}
                            checked={productId === item.id}
                            disabled={owned}
                            onChange={() => setProductId(item.id)}
                          />
                          <CardFace
                            product={item.id}
                            name={item.name}
                            network={item.network}
                            size="mini"
                          />
                          <span className="pc-option-text">
                            <strong>{item.name}</strong>
                            <small>
                              {owned
                                ? "Already requested"
                                : item.issuePriceUsd != null
                                  ? `${usd(item.issuePriceUsd)} to issue`
                                  : "Price on invoice"}
                            </small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
                <div className="cd-field-row">
                  <label className="card-field">
                    Cardholder name (optional)
                    <input
                      type="text"
                      autoComplete="cc-name"
                      maxLength={100}
                      value={cardholderName}
                      disabled={busy || loadingProfile}
                      onChange={(event) => setCardholderName(event.target.value)}
                    />
                  </label>
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
                </div>
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
                  <span>Share this email with the card provider for this application.</span>
                </label>
                {networkPicker}
              </div>
            </div>
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
              {networkPicker}
            </>
          )}
          {!config.networks.length && (
            <p className="card-error">No payment networks are currently available.</p>
          )}
          {error && (
            <p role="alert" className="card-error">
              {error}
            </p>
          )}
          <div className="card-form-actions cd-footer">
            {kind === "issue" && (
              <p className="cd-total">
                <span>Issue price</span>
                <strong>
                  {product?.issuePriceUsd != null ? usd(product.issuePriceUsd) : "On invoice"}
                </strong>
              </p>
            )}
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
