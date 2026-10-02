import { useState } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  Coffee,
  Copy,
  CreditCard,
  Eye,
  EyeOff,
  Film,
  Flame,
  Plus,
  ShoppingBag,
  Snowflake,
  Zap,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import confetti from "canvas-confetti";

const CARD = {
  lastFour: "4297",
  number: "4532 8912 4567 4297",
  expiry: "09/29",
  cvv: "452",
  balance: 1247.83,
  spent: 842.15,
  limit: 2500,
  holderName: "Dev Preview",
};

const RATE_FALLBACK = 2700;

function fmtUsd(value: number) {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("Copied to clipboard");
  } catch {
    toast.error("Copy was unavailable.");
  }
}

export default function Card() {
  const [frozen, setFrozen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [modal, setModal] = useState<"topup" | "details" | "">("");
  const [topUpAmount, setTopUpAmount] = useState("50");
  const [topUpDone, setTopUpDone] = useState(false);
  const spentPct = Math.min((CARD.spent / CARD.limit) * 100, 100);

  return (
    <div className="card-view">
      <div
        className={"ping-card-visual" + (frozen ? " frozen" : "")}
        onClick={() => setRevealed((r) => !r)}
      >
        <div className="ping-card-shine" />
        <div className="ping-card-inner">
          <div className="ping-card-top">
            <span className="ping-card-brand">
              <span className="ping-card-mark" />
              <strong>Ping</strong>
            </span>
            {frozen ? (
              <span className="ping-card-frozen">
                <Snowflake size={10} />
                FROZEN
              </span>
            ) : (
              <span className="ping-card-network">VISA</span>
            )}
          </div>
          <div className="ping-card-number">
            {revealed ? CARD.number : `•••• •••• •••• ${CARD.lastFour}`}
          </div>
          <div className="ping-card-row">
            <div>
              <small>EXPIRES</small>
              <span>{revealed ? CARD.expiry : "••/••"}</span>
            </div>
            <div>
              <small>CVV</small>
              <span>{revealed ? CARD.cvv : "•••"}</span>
            </div>
            <div className="ping-card-wave" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          </div>
        </div>
      </div>

      <div className="card-balance-block">
        <span className="eyebrow">CARD BALANCE</span>
        <div className="card-balance-amount">${fmtUsd(CARD.balance)}</div>
      </div>

      <div className="card-actions">
        <button
          type="button"
          onClick={() => {
            setTopUpDone(false);
            setModal("topup");
          }}
        >
          <span className="card-action-icon">
            <Plus size={20} />
          </span>
          <small>Top Up</small>
        </button>
        <button type="button" onClick={() => setFrozen((f) => !f)}>
          <span className="card-action-icon">
            {frozen ? <Flame size={20} /> : <Snowflake size={20} />}
          </span>
          <small>{frozen ? "Unfreeze" : "Freeze"}</small>
        </button>
        <button type="button" onClick={() => setModal("details")}>
          <span className="card-action-icon">
            <CreditCard size={20} />
          </span>
          <small>Details</small>
        </button>
      </div>

      <section className="card card-spending">
        <div className="panel-heading">
          <h2>Spending</h2>
          <span className="card-spending-period">This month</span>
        </div>
        <div className="card-spending-bar">
          <div
            style={{
              width: `${spentPct}%`,
              background: spentPct > 85 ? "var(--ping-warn)" : "var(--ping-accent)",
            }}
          />
        </div>
        <div className="card-spending-labels">
          <span>
            <strong>${fmtUsd(CARD.spent)}</strong> spent
          </span>
          <span>${fmtUsd(CARD.limit)} limit</span>
        </div>
      </section>

      <section className="card card-tx-list">
        <div className="panel-heading">
          <h2>Recent transactions</h2>
        </div>
        <TxRow icon={<Coffee size={16} />} tone="muted" merchant="Starbucks Coffee" subtitle="Today · 8:42 AM" amount="-$5.75" />
        <TxRow icon={<ArrowDown size={16} />} tone="success" merchant="Top up from ETH" subtitle="Yesterday" amount="+$200.00" positive />
        <TxRow icon={<Film size={16} />} tone="muted" merchant="Netflix" subtitle="Oct 1 · 11:00 AM" amount="-$15.99" />
        <TxRow icon={<ShoppingBag size={16} />} tone="muted" merchant="Whole Foods Market" subtitle="Sep 30 · 6:15 PM" amount="-$87.42" />
        <TxRow icon={<Zap size={16} />} tone="muted" merchant="Electric Bill" subtitle="Sep 29" amount="-$124.50" />
      </section>

      <section className="card card-info-block">
        <div className="panel-heading">
          <h2>Card info</h2>
        </div>
        <InfoRow label="Type" value="Virtual · Visa" />
        <InfoRow label="Network" value="Visa" />
        <InfoRow label="Currency" value="USD" />
        <InfoRow label="Issued" value="Sep 2026" />
        <InfoRow label="Funding" value="Crypto → Card" />
      </section>

      <Dialog
        open={!!modal}
        onOpenChange={(open) => {
          if (!open) {
            setModal("");
            setTopUpDone(false);
          }
        }}
      >
        <DialogContent className="ping-dialog card-dialog">
          {modal === "topup" && (
            <>
              <DialogTitle>Top up card</DialogTitle>
              <DialogDescription>Convert crypto to USD and load it onto your Ping Card.</DialogDescription>
              {topUpDone ? (
                <div className="topup-success">
                  <span className="topup-check">
                    <Check size={32} />
                  </span>
                  <h3>Card topped up!</h3>
                  <p>${fmtUsd(Number(topUpAmount || 0))} added to your Ping Card.</p>
                  <button
                    className="button accent"
                    onClick={() => {
                      setModal("");
                      setTopUpDone(false);
                    }}
                  >
                    Done <Check size={16} />
                  </button>
                </div>
              ) : (
                <>
                  <div className="topup-section">
                    <span className="eyebrow">FROM</span>
                    <div className="topup-source">
                      <span className="token-icon eth">
                        <img src="/assets/brands/ethereum.svg" alt="" width={34} height={34} />
                      </span>
                      <div>
                        <strong>ETH</strong>
                        <small>Balance · Robinhood Chain</small>
                      </div>
                    </div>
                  </div>
                  <div className="topup-arrow">
                    <ArrowDown size={16} />
                  </div>
                  <div className="topup-section">
                    <span className="eyebrow">TO CARD</span>
                    <div className="topup-source">
                      <span className="card-action-icon small">
                        <CreditCard size={16} />
                      </span>
                      <div>
                        <strong>Ping Card</strong>
                        <small>•••• {CARD.lastFour}</small>
                      </div>
                    </div>
                  </div>
                  <div className="topup-amount">
                    <span className="eyebrow">AMOUNT</span>
                    <div className="topup-amount-row">
                      <span>$</span>
                      <input
                        inputMode="decimal"
                        value={topUpAmount}
                        onChange={(e) => setTopUpAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                        aria-label="Amount in USD"
                      />
                    </div>
                    <div className="topup-presets">
                      {["25", "50", "100", "250"].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          className={topUpAmount === preset ? "active" : ""}
                          onClick={() => setTopUpAmount(preset)}
                        >
                          ${preset}
                        </button>
                      ))}
                    </div>
                  </div>
                  {Number(topUpAmount) > 0 && (
                    <div className="topup-rate">
                      <span>Rate</span>
                      <strong>1 ETH ≈ ${fmtUsd(RATE_FALLBACK)}</strong>
                    </div>
                  )}
                  <button
                    className="button accent"
                    disabled={!(Number(topUpAmount) > 0)}
                    onClick={() => {
                      setTopUpDone(true);
                      toast.success("Card topped up");
                      confetti({
                        particleCount: 120,
                        spread: 70,
                        startVelocity: 38,
                        origin: { y: 0.6 },
                        colors: ["#AB9FF2", "#C9BBFF", "#8575DE", "#45E39A", "#F5F2FA"],
                      });
                    }}
                  >
                    Top up ${fmtUsd(Number(topUpAmount || 0))} <ArrowUpRight size={16} />
                  </button>
                  <p className="field-help">Crypto is converted to USD and loaded onto your card instantly. No fees.</p>
                </>
              )}
            </>
          )}
          {modal === "details" && (
            <>
              <DialogTitle>Card details</DialogTitle>
              <DialogDescription>Reveal and copy the full card number and security details.</DialogDescription>
              <div className="card-details-list">
                <DetailRow label="Card number" value={revealed ? CARD.number : `•••• •••• •••• ${CARD.lastFour}`} copyValue={CARD.number} />
                <DetailRow label="Expiry" value={revealed ? CARD.expiry : "••/••"} copyValue={CARD.expiry} />
                <DetailRow label="CVV" value={revealed ? CARD.cvv : "•••"} copyValue={CARD.cvv} />
                <DetailRow label="Cardholder" value={CARD.holderName} copyValue={CARD.holderName} />
              </div>
              <button
                type="button"
                className="button outline card-reveal-btn"
                onClick={() => setRevealed((r) => !r)}
              >
                {revealed ? (
                  <>
                    <EyeOff size={16} />
                    Hide details
                  </>
                ) : (
                  <>
                    <Eye size={16} />
                    Reveal details
                  </>
                )}
              </button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TxRow({
  icon,
  tone,
  merchant,
  subtitle,
  amount,
  positive,
}: {
  icon: React.ReactNode;
  tone: "muted" | "success";
  merchant: string;
  subtitle: string;
  amount: string;
  positive?: boolean;
}) {
  return (
    <div className="card-tx-row">
      <span className={"card-tx-icon " + tone}>{icon}</span>
      <div>
        <strong>{merchant}</strong>
        <small>{subtitle}</small>
      </div>
      <span className={"card-tx-amount" + (positive ? " positive" : "")}>{amount}</span>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="card-info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DetailRow({ label, value, copyValue }: { label: string; value: string; copyValue: string }) {
  return (
    <div className="card-detail-row">
      <div>
        <small>{label}</small>
        <span>{value}</span>
      </div>
      <button type="button" aria-label={`Copy ${label}`} onClick={() => copy(copyValue)}>
        <Copy size={14} />
      </button>
    </div>
  );
}
