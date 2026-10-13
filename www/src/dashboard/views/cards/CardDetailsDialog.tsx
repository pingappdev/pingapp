import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff } from "lucide-react";
import { cardsApi, type CardDetails } from "@/api/cards";
import { qk, sessionRevision } from "@/api/hooks";
import type { Me } from "@/api/types";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { copyText } from "./format";
import { revealWhenVisible } from "./reveal";

export function CardDetailsDialog({
  userId,
  cardId,
  last4,
  withReauth,
  onClose,
}: {
  userId: string;
  cardId: string;
  last4: string | null;
  withReauth: <T>(fn: () => Promise<T>) => Promise<T>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [details, setDetails] = useState<CardDetails | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  const expires = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const requestLock = useRef(false);
  const mounted = useRef(false);
  const revision = useRef(sessionRevision(queryClient));
  function clear() {
    generation.current += 1;
    expires.current = 0;
    controller.current?.abort();
    setDetails(null);
    setBusy(false);
  }
  function current(token: number) {
    return (
      mounted.current &&
      generation.current === token &&
      sessionRevision(queryClient) === revision.current &&
      queryClient.getQueryData<Me | null>(qk.session)?.id === userId
    );
  }
  useEffect(() => {
    mounted.current = true;
    const hide = () => {
      if (document.hidden) {
        // An app switch is expected during mobile wallet authentication. Only
        // invalidate details already exposed, not the pending authentication.
        if (expires.current > 0) {
          generation.current += 1;
          controller.current?.abort();
          setBusy(false);
        }
        expires.current = 0;
        setDetails(null);
      }
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      mounted.current = false;
      generation.current += 1;
      expires.current = 0;
      controller.current?.abort();
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  useEffect(() => {
    if (!details) return;
    const token = generation.current;
    const timer = window.setTimeout(
      () => {
        if (generation.current !== token) return;
        generation.current += 1;
        expires.current = 0;
        setDetails(null);
        setMessage("Details hidden after one minute. Reveal again when needed.");
      },
      Math.max(0, expires.current - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [details]);
  async function reveal() {
    if (requestLock.current) return;
    requestLock.current = true;
    const token = ++generation.current;
    controller.current = new AbortController();
    const signal = controller.current.signal;
    setBusy(true);
    setMessage(null);
    try {
      const result = await withReauth(() =>
        revealWhenVisible(() => cardsApi.reveal(cardId, { signal }), {
          signal,
          isCurrent: () => current(token),
        }),
      );
      if (current(token) && !signal.aborted && !document.hidden) {
        expires.current = Date.now() + 60_000;
        setDetails(result);
      }
    } catch (error) {
      if (current(token) && !signal.aborted)
        setMessage(error instanceof Error ? error.message : "Could not reveal details.");
    } finally {
      requestLock.current = false;
      if (current(token)) setBusy(false);
    }
  }
  async function copy(value: string) {
    const token = generation.current;
    if (!current(token) || document.hidden || Date.now() >= expires.current) {
      clear();
      return;
    }
    try {
      await copyText(value);
      if (current(token)) setMessage("Copied to clipboard.");
    } catch {
      if (current(token)) setMessage("Copy was unavailable. Select the revealed value to copy it.");
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          clear();
          onClose();
        }
      }}
    >
      <DialogContent className="ping-dialog card-dialog">
        <DialogTitle>Card details</DialogTitle>
        <DialogDescription>
          Reveal only when you need to pay. Details hide after one minute, when you close this
          window, or when you leave this tab.
        </DialogDescription>
        <div className="card-details-list">
          {[
            {
              label: "Card number",
              value: details?.number,
              masked: `•••• •••• •••• ${last4 ?? "••••"}`,
            },
            { label: "Expiry", value: details?.expiry, masked: "••/••" },
            { label: "CVV", value: details?.cvv, masked: "•••" },
            {
              label: "Cardholder",
              value: details?.holderName,
              masked: details ? "Not supplied" : "Hidden",
            },
          ].map(({ label, value, masked }) => (
            <div className="card-detail-row" key={label}>
              <div>
                <small>{label}</small>
                <span>{value ?? masked}</span>
              </div>
              {value && (
                <button type="button" aria-label={`Copy ${label}`} onClick={() => void copy(value)}>
                  <Copy size={15} />
                </button>
              )}
            </div>
          ))}
        </div>
        {message && (
          <p role="status" className="field-help">
            {message}
          </p>
        )}
        <button
          type="button"
          className="button outline card-reveal-btn"
          disabled={busy}
          onClick={() => (details ? clear() : void reveal())}
        >
          {details ? <EyeOff size={16} /> : <Eye size={16} />}
          {details ? "Hide details" : busy ? "Confirming access…" : "Reveal details"}
        </button>
      </DialogContent>
    </Dialog>
  );
}
