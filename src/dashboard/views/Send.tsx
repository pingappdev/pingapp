import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Link2, ShieldCheck, Wallet } from "lucide-react";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { useAccount } from "wagmi";
import { ApiError } from "../../api/client";
import { useBalances, useConfig, useContacts, useIntents, useResolve } from "../../api/hooks";
import type { Asset, Contact, Me, ResolveResponse } from "../../api/types";
import { useAuth } from "../../auth/useAuth";
import { chain } from "../../config";
import { useSearchParams } from "../../routing";
import { openConnect } from "../../wallet/appkit";
import { trimAddress } from "../format";
import Connection from "../components/Connection";
import NetworkLabel from "../components/NetworkLabel";
import AmountField from "./send/AmountField";
import RecipientCard from "./send/RecipientCard";
import RecipientField from "./send/RecipientField";
import SendReviewDialog from "./send/SendReviewDialog";
import TokenSelect from "./send/TokenSelect";
import TransferProgress from "./send/TransferProgress";
import { rawAmount, sendMinimum } from "./send/money";
import type { Recipient } from "./send/types";
import { fromResolved } from "./send/types";
import { useSendTransaction, type ReviewedSend } from "./send/useSendTransaction";

function defaultCountry(): CountryCode {
  if (typeof navigator === "undefined") return "US";
  const region = navigator.language.split(/[-_]/)[1]?.toUpperCase();
  return region && /^[A-Z]{2}$/.test(region) ? (region as CountryCode) : "US";
}

function resolveError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "SELF_SEND") return "That's your own wallet.";
    if (error.code === "INVALID_PHONE") return "Enter a valid phone number.";
    if (error.code === "RATE_LIMITED") return "Too many lookups. Try again later.";
    return error.message;
  }
  return "We couldn't look up this number. Try again.";
}

export default function Send() {
  const { me } = useAuth();
  return <SendSession key={me ? `${me.id}:${me.address.toLowerCase()}` : "signed-out"} me={me} />;
}

function SendSession({ me }: { me: Me | null }) {
  const account = useAccount();
  const params = useSearchParams();
  const intentId = params.get("intent");
  const intents = useIntents("open");
  const intent = intentId ? intents.data?.find((item) => item.id === intentId) : undefined;
  const locked = !!intentId;
  const balances = useBalances();
  const contacts = useContacts();
  const config = useConfig();
  const { mutateAsync: resolvePhone } = useResolve();
  const [input, setInput] = useState("");
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [resolution, setResolution] = useState<ResolveResponse | null>(null);
  const [resolutionPhone, setResolutionPhone] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [recipientError, setRecipientError] = useState("");
  const [prefillError, setPrefillError] = useState("");
  const [freshRecipient, setFreshRecipient] = useState<Recipient | null>(null);
  const [tokenAddress, setTokenAddress] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState<ReviewedSend | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const prefilled = useRef("");
  const cache = useRef(new Map<string, ResolveResponse>());

  const onChangedRecipient = (
    next: Recipient | null,
    updated?: ResolveResponse,
    requestedPhone?: string,
  ) => {
    setFreshRecipient(next);
    if (updated) {
      setResolution(updated);
      const phoneKey = requestedPhone ?? next?.phone;
      setResolutionPhone(phoneKey ?? null);
      setRecipientError("");
      if (phoneKey) cache.current.set(phoneKey, updated);
    } else if (!next) {
      setResolution(null);
      setResolutionPhone(null);
    }
    setReview(null);
    setReviewOpen(false);
  };
  const send = useSendTransaction(me, onChangedRecipient);

  useEffect(() => {
    if (locked) return;
    const key = params.toString();
    if (prefilled.current === key) return;
    const contactId = params.get("contact");
    if (contactId && !contacts.data) return;
    prefilled.current = key;
    setInput("");
    setSelectedContact(null);
    setResolution(null);
    setResolutionPhone(null);
    setFreshRecipient(null);
    setRecipientError("");
    setPrefillError("");
    setReview(null);
    setReviewOpen(false);
    const contact = contacts.data?.find((item) => item.id === contactId);
    if (contact) {
      if (contact.phone) {
        setSelectedContact(contact);
        setInput(contact.phone);
      } else {
        setPrefillError("This contact needs a phone number before you can send crypto.");
      }
    } else if (params.get("to")) {
      const to = params.get("to")!.trim();
      if (/^0x/i.test(to)) {
        setPrefillError("Send by phone number only. Enter the recipient's phone number.");
      } else {
        try {
          const parsed = parsePhoneNumberFromString(to, defaultCountry());
          if (parsed?.isValid()) setInput(parsed.number);
          else setPrefillError("Enter a valid recipient phone number.");
        } catch {
          setPrefillError("Enter a valid recipient phone number.");
        }
      }
    }
  }, [contacts.data, locked, params]);

  const phone = useMemo(() => {
    if (!input.trim()) return null;
    try {
      const parsed = parsePhoneNumberFromString(input, defaultCountry());
      return parsed?.isValid() ? parsed : null;
    } catch {
      return null;
    }
  }, [input]);
  const e164 = phone?.number;

  useEffect(() => {
    if (locked || !e164) {
      setResolution(null);
      setResolutionPhone(null);
      setResolving(false);
      return;
    }
    let active = true;
    const saved = cache.current.get(e164);
    if (saved) {
      setResolution(saved);
      setResolutionPhone(e164);
      setResolving(false);
      setRecipientError("");
      return () => {
        active = false;
      };
    }
    setResolution(null);
    setResolutionPhone(null);
    setResolving(true);
    setRecipientError("");
    const timer = window.setTimeout(() => {
      void resolvePhone(e164)
        .then((result) => {
          cache.current.set(e164, result);
          if (active) {
            setResolution(result);
            setResolutionPhone(e164);
          }
        })
        .catch((error: unknown) => {
          if (active) setRecipientError(resolveError(error));
        })
        .finally(() => {
          if (active) setResolving(false);
        });
    }, 600);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [e164, locked, resolvePhone]);
  const currentResolution = e164 && resolutionPhone === e164 ? resolution : null;

  const assets = balances.data?.items ?? [];
  const eth = assets.find((asset) => asset.token.kind === "native");
  const usdg = assets.find((asset) => asset.token.symbol === "USDG");
  const defaultAsset =
    eth && BigInt(eth.balanceRaw) > 200_000_000_000_000n
      ? eth
      : usdg && BigInt(usdg.balanceRaw) > 0n
        ? usdg
        : eth;
  const selectedAsset: Asset | null = intent
    ? (assets.find(
        (asset) => asset.token.address.toLowerCase() === intent.token.address.toLowerCase(),
      ) ?? {
        token: intent.token,
        balanceRaw: "0",
        balance: "0",
        valueUsd: null,
      })
    : (assets.find((asset) => asset.token.address.toLowerCase() === tokenAddress?.toLowerCase()) ??
      defaultAsset ??
      null);
  const shownAmount = intent ? intent.amount : amount;
  const raw = selectedAsset ? rawAmount(shownAmount, selectedAsset.token.decimals) : null;
  const minimum = selectedAsset?.token.minAmount
    ? rawAmount(selectedAsset.token.minAmount, selectedAsset.token.decimals)
    : null;
  const ethRaw = eth ? BigInt(eth.balanceRaw) : 0n;
  const minSendUsd = config.data?.limits.minSendUsd ?? "";
  const amountError = !selectedAsset
    ? "Balances are unavailable."
    : selectedAsset.token.minAmount === null
      ? "Price unavailable, so this token can't be sent right now."
      : shownAmount && raw === null
        ? `Enter a valid amount with at most ${selectedAsset.token.decimals} decimal places.`
        : raw !== null && raw <= 0n
          ? "Enter an amount greater than zero."
          : raw !== null && minimum !== null && raw < minimum
            ? sendMinimum(selectedAsset.token, minSendUsd)
            : raw !== null && raw > BigInt(selectedAsset.balanceRaw)
              ? "More than your balance."
              : intent && raw !== null && raw.toString() !== intent.amountRaw
                ? "This pending send amount changed. Review it from Requests."
                : selectedAsset.token.kind !== "native" && ethRaw === 0n
                  ? "You need a little ETH on Robinhood Chain to pay the network fee."
                  : "";

  let recipient: Recipient | null = null;
  let immediateError = "";
  if (intentId) {
    if (
      intent?.status === "ready" &&
      intent.recipient &&
      Date.parse(intent.expiresAt) > Date.now()
    ) {
      recipient = {
        kind: "intent",
        address: intent.recipient.address,
        name: intent.recipient.displayName || "PingApp user",
        phoneMasked: intent.recipientPhoneMasked,
      };
    }
  } else if (e164 && currentResolution?.status === "registered") {
    recipient =
      freshRecipient?.phone === e164
        ? freshRecipient
        : fromResolved(currentResolution, e164, selectedContact?.id);
  } else if (input.trim() && !e164) immediateError = "Enter a valid phone number.";

  const pendingUrl = e164
    ? `/dashboard/requests?new=1&phone=${encodeURIComponent(e164)}&token=${encodeURIComponent(selectedAsset?.token.address ?? "")}&amount=${encodeURIComponent(shownAmount)}`
    : undefined;
  const blocked =
    !!amountError ||
    !raw ||
    !recipient ||
    !config.data ||
    send.busy ||
    !!send.pending ||
    !!send.transferId;

  function changeInput(value: string) {
    setInput(value);
    setSelectedContact(null);
    setResolution(null);
    setResolutionPhone(null);
    setRecipientError("");
    setPrefillError("");
    setFreshRecipient(null);
    setReview(null);
    setReviewOpen(false);
  }

  function selectContact(contact: Contact) {
    if (!contact.phone) return;
    changeInput(contact.phone);
    setSelectedContact(contact);
  }

  function startReview() {
    if (blocked || !selectedAsset || !recipient || !raw) return;
    setReview({
      recipient,
      token: selectedAsset.token,
      amount: shownAmount,
      amountRaw: raw.toString(),
      ...(intentId ? { intentId } : {}),
    });
    setReviewOpen(true);
  }

  function reset() {
    send.reset();
    setInput("");
    setSelectedContact(null);
    setResolution(null);
    setResolutionPhone(null);
    setFreshRecipient(null);
    setPrefillError("");
    setAmount("");
    setTokenAddress(null);
    setReview(null);
    setReviewOpen(false);
    if (intentId) window.location.assign("/dashboard/send");
  }

  return (
    <div className="send-grid">
      <section className="card send-form">
        <h2>Transfer details</h2>
        <p>Enter a phone number or choose a saved phone contact.</p>
        {intentId &&
          (intents.isPending ? (
            <p className="field-help">Loading pending send…</p>
          ) : recipient ? (
            <div className="recipient-match">Completing your pending send to {recipient.name}</div>
          ) : (
            <div className="notice">
              This pending send isn&apos;t ready yet.{" "}
              <a href="/dashboard/requests">View requests</a>
            </div>
          ))}
        {!send.pending && !send.transferId && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              startReview();
            }}
          >
            {locked ? (
              <RecipientCard recipient={recipient} />
            ) : (
              <>
                <RecipientField
                  value={input}
                  onChange={changeInput}
                  onContact={selectContact}
                  contacts={contacts.data ?? []}
                  formattedPhone={phone?.formatInternational()}
                  locked={send.busy}
                />
                <RecipientCard
                  recipient={recipient}
                  resolution={currentResolution}
                  resolving={resolving}
                  error={recipientError || prefillError || immediateError}
                  pendingUrl={pendingUrl}
                />
              </>
            )}
            <div className="send-network-label">
              <span>Network</span>
              <NetworkLabel />
              <span className={`chain-environment${chain.testnet ? " testnet" : ""}`}>
                {chain.testnet ? "Testnet" : "Mainnet"}
              </span>
            </div>
            <TokenSelect
              assets={assets}
              selected={selectedAsset}
              onSelect={(asset) => {
                setTokenAddress(asset.token.address);
                setAmount("");
                setReview(null);
              }}
              minSendUsd={minSendUsd}
              locked={locked || send.busy}
            />
            <AmountField
              asset={selectedAsset}
              value={shownAmount}
              onChange={setAmount}
              error={shownAmount ? amountError : ""}
              locked={locked || send.busy}
            />
            <p className="field-help">Network fees are shown in your wallet.</p>
            <button className="button accent" type="submit" disabled={blocked}>
              Review transfer <ArrowUpRight size={17} />
            </button>
          </form>
        )}
        {(send.pending || send.transferId) && (
          <TransferProgress
            transferId={send.transferId}
            pending={send.pending?.input ?? null}
            recordError={send.recordError}
            retryRecord={() => void send.retryRecord()}
            busy={send.busy}
            onReset={reset}
          />
        )}
      </section>
      <aside>
        <section className="card send-wallet">
          <Wallet />
          <h3>Your sending wallet</h3>
          <p>{trimAddress(me?.address ?? "")}</p>
          <Connection />
          <button className="button outline" type="button" onClick={() => void openConnect()}>
            {account.isConnected ? "Reconnect wallet" : "Connect wallet"} <Link2 size={16} />
          </button>
        </section>
        <section className="send-note">
          <ShieldCheck />
          <h3>Review before sending</h3>
          <p>
            A phone number points to a wallet its owner verified. Check the name and the full
            address before approving; transfers can&apos;t be reversed.
          </p>
          <a href="/insights/safer-connections" className="text-link">
            Read the guide <ArrowUpRight size={15} />
          </a>
        </section>
      </aside>
      <SendReviewDialog
        review={review}
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        busy={send.busy}
        onConfirm={() => {
          if (!review) return;
          setReviewOpen(false);
          void send.execute(review);
        }}
      />
    </div>
  );
}
