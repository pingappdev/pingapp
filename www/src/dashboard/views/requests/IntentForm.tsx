import { useCanShare } from "@/platform/useCanShare";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, Copy, LoaderCircle, Plus, Send, Share2 } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "../../../api/client";
import { useConfig, useCreateIntent, useTokens } from "../../../api/hooks";
import type { Intent } from "../../../api/types";
import { useSearchParams } from "../../../routing";
import PhoneInput from "../../components/PhoneInput";
import TokenPicker from "./TokenPicker";
import { rawAmount, sendMinimum } from "../send/money";
import { copyInvite, shareInvite, smsCopy, tokenChoices, validPhone } from "./utils";

export default function IntentForm({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const params = useSearchParams();
  const searchKey = params.toString();
  const tokensQuery = useTokens();
  const config = useConfig();
  const createIntent = useCreateIntent();
  const tokens = useMemo(() => tokenChoices(tokensQuery.data ?? []), [tokensQuery.data]);
  const [phone, setPhone] = useState("");
  const [tokenAddress, setTokenAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<Error | null>(null);
  const [directPhone, setDirectPhone] = useState("");
  const [createdIntent, setCreatedIntent] = useState<Intent | null>(null);
  const createInFlight = useRef(false);
  const prefilledSearch = useRef("");
  const selectedToken =
    tokens.find((token) => token.address.toLowerCase() === tokenAddress.toLowerCase()) ?? null;
  const currentRaw = selectedToken ? rawAmount(amount, selectedToken.decimals) : null;
  const minRaw = selectedToken?.minAmount
    ? rawAmount(selectedToken.minAmount, selectedToken.decimals)
    : null;
  const belowMinimum =
    currentRaw !== null && minRaw !== null && currentRaw > 0n && currentRaw < minRaw;
  const configReady = Boolean(config.data?.limits.minSendUsd);
  const shareAvailable = useCanShare();

  useEffect(() => {
    if (!tokensQuery.data || prefilledSearch.current === searchKey) return;
    prefilledSearch.current = searchKey;
    const phoneParam = params.get("phone");
    const amountParam = params.get("amount");
    const tokenParam = params.get("token");
    if (phoneParam !== null) setPhone(phoneParam);
    if (amountParam !== null) setAmount(amountParam.replace(/,/g, "."));
    if (tokenParam) {
      const matched = tokens.find(
        (token) =>
          token.address.toLowerCase() === tokenParam.toLowerCase() ||
          token.symbol.toLowerCase() === tokenParam.toLowerCase(),
      );
      if (matched) setTokenAddress(matched.address);
    } else if (!tokenAddress && tokens.length > 0) {
      setTokenAddress(tokens[0].address);
    }
    if (params.get("new") === "1") onOpenChange(true);
  }, [onOpenChange, params, searchKey, tokenAddress, tokens, tokensQuery.data]);

  function resetError() {
    setFormError(null);
    setDirectPhone("");
  }

  async function submitIntent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createIntent.isPending || createInFlight.current) return;
    resetError();
    if (!validPhone(phone)) {
      setFormError(new Error("Enter a valid phone number with its country code."));
      return;
    }
    if (!selectedToken || selectedToken.minAmount === null || minRaw === null) {
      setFormError(new Error("Choose a token whose price is available."));
      return;
    }
    if (currentRaw === null || currentRaw <= 0n) {
      setFormError(new Error("Enter a valid amount."));
      return;
    }
    if (!configReady || !config.data) {
      setFormError(new Error("Send limits are still loading. Try again in a moment."));
      return;
    }
    if (belowMinimum) {
      setFormError(new Error(sendMinimum(selectedToken, config.data.limits.minSendUsd)));
      return;
    }

    createInFlight.current = true;
    try {
      const { intent } = await createIntent.mutateAsync({
        phone,
        tokenAddress: selectedToken.address,
        amount,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setCreatedIntent(intent);
      setPhone("");
      setAmount("");
      setNote("");
      onOpenChange(false);
      const message = smsCopy(intent.smsStatus);
      if (intent.smsStatus === "sent") toast.success(message);
      else toast(message);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "CONFLICT") {
        const recipient = reason.details?.recipient;
        if (recipient && typeof recipient === "object") {
          const displayName = (recipient as Record<string, unknown>).displayName;
          setFormError(
            new Error(
              `${typeof displayName === "string" && displayName.trim() ? displayName : "This person"} is already on PingApp.`,
            ),
          );
          setDirectPhone(phone);
        } else if (typeof reason.details?.intentId === "string") {
          setFormError(new Error("You already have a pending send to this number."));
        } else {
          setFormError(reason);
        }
      } else {
        setFormError(
          reason instanceof Error ? reason : new Error("Could not create the pending send."),
        );
      }
    } finally {
      createInFlight.current = false;
    }
  }

  return (
    <section className="card request-create-card">
      <div className="panel-heading">
        <div>
          <h2>New pending send</h2>
          {!open && (
            <p className="field-help">Invite someone who hasn&apos;t linked a wallet yet.</p>
          )}
        </div>
        <button
          className="button outline"
          type="button"
          aria-expanded={open}
          disabled={createIntent.isPending}
          onClick={() => onOpenChange(!open)}
        >
          {open ? (
            "Close"
          ) : (
            <>
              <Plus size={15} /> Create invite
            </>
          )}
        </button>
      </div>

      {createdIntent && (
        <div className="request-sms-result" role="status">
          <div>
            <strong>{smsCopy(createdIntent.smsStatus)}</strong>
            <p>Nothing has left your wallet. The sender still needs to complete a transfer.</p>
          </div>
          <div className="request-intent-actions">
            <button
              className="button outline"
              type="button"
              onClick={() => void copyInvite(createdIntent.claimUrl)}
            >
              <Copy size={14} /> Copy invite link
            </button>
            {shareAvailable && (
              <button
                className="button outline"
                type="button"
                onClick={() => void shareInvite(createdIntent)}
              >
                <Share2 size={14} /> Share
              </button>
            )}
            <a
              className="request-open-invite"
              href={createdIntent.claimUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open invite <ArrowUpRight size={14} />
            </a>
          </div>
        </div>
      )}

      {open && (
        <form className="send-form request-form" onSubmit={(event) => void submitIntent(event)}>
          <p>
            Nothing leaves your wallet now. We&apos;ll text them an invite from PingApp with your
            name. When they link this number, you&apos;ll get a notification to complete the
            transfer. Invites expire after {config.data?.limits.intentTtlDays ?? "the configured"}{" "}
            days.
          </p>
          <div className="send-recipient-field">
            <label>Phone</label>
            <PhoneInput
              value={phone}
              onChange={(value) => {
                setPhone(value ?? "");
                resetError();
              }}
              disabled={createIntent.isPending}
              placeholder="Recipient phone number"
            />
          </div>
          {tokensQuery.isPending ? (
            <p className="field-help" role="status">
              Loading tokens…
            </p>
          ) : tokensQuery.isError ? (
            <div className="request-query-message" role="alert">
              <span>Tokens could not load.</span>
              <button
                className="text-link"
                type="button"
                onClick={() => void tokensQuery.refetch()}
              >
                Try again
              </button>
            </div>
          ) : (
            <TokenPicker
              tokens={tokens}
              selected={selectedToken}
              disabled={createIntent.isPending}
              onSelect={(token) => {
                setTokenAddress(token.address);
                resetError();
              }}
            />
          )}
          <div className="send-amount-field">
            <label htmlFor="pending-amount">Amount</label>
            <div className="amount-input-wrap">
              <input
                id="pending-amount"
                className="auth-input"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={amount}
                disabled={createIntent.isPending}
                onChange={(event) => {
                  setAmount(event.target.value.replace(/,/g, "."));
                  resetError();
                }}
              />
              <span>{selectedToken?.symbol ?? "TOKEN"}</span>
            </div>
            {belowMinimum && selectedToken && config.data && (
              <p className="field-help" role="alert">
                {sendMinimum(selectedToken, config.data.limits.minSendUsd)}
              </p>
            )}
          </div>
          <label className="request-note-label">
            Note (optional)
            <textarea
              className="auth-input request-note"
              maxLength={140}
              value={note}
              disabled={createIntent.isPending}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Add a short note"
            />
            <small>{note.length}/140</small>
          </label>
          {config.isPending && (
            <p className="field-help" role="status">
              Loading send limits…
            </p>
          )}
          {config.isError && (
            <div className="request-query-message" role="alert">
              <span>
                Send limits could not load. Creating pending sends is unavailable until they do.
              </span>
              <button className="text-link" type="button" onClick={() => void config.refetch()}>
                Try again
              </button>
            </div>
          )}
          {formError && (
            <div className="request-form-error" role="alert">
              <p>{formError.message}</p>
              {formError instanceof ApiError && formError.code === "DISPLAY_NAME_REQUIRED" && (
                <a className="text-link" href="/dashboard/settings">
                  Add your name in Settings
                </a>
              )}
              {directPhone && (
                <a
                  className="button outline"
                  href={`/dashboard/send?to=${encodeURIComponent(directPhone)}`}
                >
                  Send directly <ArrowUpRight size={14} />
                </a>
              )}
            </div>
          )}
          <div className="request-submit-row">
            <button
              className="button accent"
              type="submit"
              disabled={
                createIntent.isPending ||
                createInFlight.current ||
                !configReady ||
                !validPhone(phone) ||
                !selectedToken ||
                selectedToken.minAmount === null ||
                minRaw === null ||
                currentRaw === null ||
                currentRaw <= 0n ||
                belowMinimum
              }
            >
              {createIntent.isPending ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Send size={15} />
              )}
              {createIntent.isPending ? "Creating invite…" : "Create pending send"}
            </button>
            <span className="field-help">
              No crypto is sent until you approve it in your wallet.
            </span>
          </div>
        </form>
      )}
    </section>
  );
}
