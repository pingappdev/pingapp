import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Smartphone } from "lucide-react";
import { ApiError } from "@/api/client";
import { cardsApi, type ApplePayState } from "@/api/cards";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { copyText } from "./format";

const POLL_MS = 4000;

// Deadlines come from the server's remaining seconds, so a skewed device clock
// cannot hide a valid code or keep showing an expired one.
type Local = ApplePayState & { deadline?: number };
const local = (state: ApplePayState): Local =>
  state.status === "idle" ? state : { ...state, deadline: Date.now() + state.expiresInSec * 1000 };

function remaining(deadline: number, now: number) {
  const seconds = Math.max(0, Math.round((deadline - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Apple Pay activation for the Mastercard card. The card provider watches for the
 * issuer's verification code for ten minutes after "Start activation". The state
 * lives on the server, so leaving for Wallet and coming back resumes here. The code
 * is held only in component state and is dropped when the dialog closes.
 */
export function ApplePayDialog({
  cardId,
  last4,
  available,
  withReauth,
  onShowDetails,
  onClose,
}: {
  cardId: string;
  last4: string | null;
  available: boolean;
  withReauth: <T>(fn: () => Promise<T>) => Promise<T>;
  onShowDetails: () => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<Local | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [ended, setEnded] = useState(false);
  const mounted = useRef(true);
  const starting = useRef(false);
  const lastStatus = useRef<ApplePayState["status"] | null>(null);

  const poll = useCallback(async () => {
    if (!available) return;
    try {
      const { applePay } = await cardsApi.applePay(cardId);
      if (!mounted.current) return;
      if (lastStatus.current === "waiting" && applePay.status === "idle") setEnded(true);
      lastStatus.current = applePay.status;
      setError(null);
      setState(local(applePay));
    } catch (caught) {
      if (mounted.current && !(caught instanceof ApiError && caught.code === "NETWORK"))
        setError(caught instanceof Error ? caught.message : "Activation status is unavailable.");
    }
  }, [available, cardId]);

  useEffect(() => {
    mounted.current = true;
    void poll();
    return () => {
      mounted.current = false;
    };
  }, [poll]);

  const waiting = state?.status === "waiting";
  useEffect(() => {
    if (!waiting && state?.status !== "delivered") return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const timer = waiting ? window.setInterval(() => void poll(), POLL_MS) : 0;
    // Returning from Wallet: check at once rather than on the next interval.
    const visible = () => {
      if (!document.hidden && waiting) void poll();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(tick);
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [waiting, state?.status, poll]);

  // The window closed on the device clock; the server confirms on the next poll.
  const expired = state?.deadline !== undefined && state.deadline <= now;

  async function start() {
    // A ref, not state: two quick clicks must not both reach the server.
    if (starting.current || !available) return;
    starting.current = true;
    setBusy(true);
    setError(null);
    setEnded(false);
    try {
      const { applePay } = await withReauth(() => cardsApi.armApplePay(cardId));
      if (mounted.current) {
        setNow(Date.now());
        lastStatus.current = applePay.status;
        setState(local(applePay));
      }
    } catch (caught) {
      if (mounted.current)
        setError(caught instanceof Error ? caught.message : "Activation could not start.");
    } finally {
      starting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function copy(code: string) {
    try {
      await copyText(code);
      setCopied(true);
      window.setTimeout(() => mounted.current && setCopied(false), 2000);
    } catch {
      setError("Copy was unavailable. Type the code into Wallet.");
    }
  }

  const delivered = state?.status === "delivered" && !expired ? state : null;
  const activeWait = waiting && !expired;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="ping-dialog card-dialog ap-dialog">
        <DialogTitle>Add to Apple Pay</DialogTitle>
        <DialogDescription>
          Mastercard {last4 ? `ending ${last4}` : ""}. Apple Wallet asks for a one-time verification
          code, and PingApp shows it here.
        </DialogDescription>
        {!available ? (
          <p className="card-sandbox" role="note">
            Apple Pay activation needs a live card. The card provider does not offer it in sandbox
            mode.
          </p>
        ) : delivered ? (
          <section className="ap-code" aria-live="polite">
            <p>Enter this code in Wallet</p>
            <strong className="ap-code-value">{delivered.code}</strong>
            <div className="ap-code-actions">
              <button
                type="button"
                className="button outline"
                onClick={() => void copy(delivered.code)}
              >
                <Copy size={16} /> {copied ? "Copied" : "Copy code"}
              </button>
              <span>Expires in {remaining(delivered.deadline ?? now, now)}</span>
            </div>
          </section>
        ) : (
          <ol className="ap-steps">
            <li data-state={activeWait ? "done" : "current"}>
              <div>
                <strong>Start activation</strong>
                <p>The card provider watches for your code for 10 minutes.</p>
                {!activeWait && (
                  <button
                    type="button"
                    className="button accent"
                    disabled={busy}
                    onClick={() => void start()}
                  >
                    {busy
                      ? "Confirm in your wallet…"
                      : ended || expired
                        ? "Start again"
                        : "Start activation"}
                  </button>
                )}
              </div>
            </li>
            <li data-state={activeWait ? "current" : "todo"}>
              <div>
                <strong>Add the card in Apple Wallet</strong>
                <p>
                  Open Wallet, tap +, choose Debit or Credit Card, and enter the card details
                  manually.
                </p>
                <button
                  type="button"
                  className="button outline"
                  disabled={!activeWait}
                  onClick={onShowDetails}
                >
                  <Smartphone size={16} /> Show card details
                </button>
              </div>
            </li>
            <li data-state="todo">
              <div>
                <strong>Enter the code</strong>
                <p>
                  {activeWait
                    ? `Waiting for the code. ${remaining(state.deadline ?? now, now)} left.`
                    : "The code appears here when Wallet asks for it."}
                </p>
              </div>
            </li>
          </ol>
        )}
        {(ended || expired) && !delivered && available && (
          <p className="field-help" role="status">
            The activation window ended without a code. Start again, then add the card in Wallet
            within 10 minutes.
          </p>
        )}
        {error && (
          <p role="alert" className="card-error">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
