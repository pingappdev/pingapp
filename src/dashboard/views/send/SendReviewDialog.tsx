import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { formatEther } from "viem";
import { explorerAddress } from "../../../config";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import AddressText from "../../components/AddressText";
import Usd from "../../components/Usd";
import { usdForRaw } from "./money";
import { recipientWarnings } from "./types";
import type { ReviewedSend } from "./useSendTransaction";

export default function SendReviewDialog({
  review,
  open,
  onOpenChange,
  onConfirm,
  busy,
}: {
  review: ReviewedSend | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const [checked, setChecked] = useState(false);
  const [confirmedReview, setConfirmedReview] = useState(false);
  useEffect(() => {
    setChecked(false);
    setConfirmedReview(false);
  }, [review, open]);
  if (!review) return null;
  const { recipient, token, amount, amountRaw } = review;
  const escrow = recipient.kind === "escrow";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="ping-dialog">
        <DialogTitle>Review your transfer</DialogTitle>
        <DialogDescription>
          {escrow ? "Confirm the phone number and escrow charges, then approve in your wallet."
            : "Confirm the recipient and full address, then approve the request in your wallet."}
        </DialogDescription>
        <div className="review-amount">
          {amount} <span>{token.symbol}</span>
        </div>
        <p className="field-help">
          Estimated value: <Usd value={usdForRaw(BigInt(amountRaw), token)} />
        </p>
        <dl className="review-details">
          <dt>Recipient</dt>
          <dd>
            {recipient.name}
            {recipient.phoneMasked ? ` · ${recipient.phoneMasked}` : ""}
          </dd>
          {!escrow && <><dt>Full address</dt><dd><AddressText value={recipient.address} full /></dd></>}
          {escrow && review.router && <>
            <dt>SMS fee (nonrefundable)</dt><dd>{formatEther(BigInt(review.router.escrowFeeWei))} ETH</dd>
            <dt>Claim gas tip</dt><dd>{formatEther(BigInt(review.router.claimTipWei))} ETH · refunded if unclaimed</dd>
          </>}
          {review.router?.enabled && review.router.address && <>
            <dt>Router</dt><dd>
              <AddressText value={review.router.address} full />
              <a href={explorerAddress(review.router.address)} target="_blank" rel="noreferrer">View router in explorer</a>
            </dd>
          </>}
          <dt>Network</dt>
          <dd>Robinhood Chain</dd>
          <dt>Network fee</dt>
          <dd>Shown in your wallet</dd>
        </dl>
        {escrow && <>
          <p className="field-help">If they don&apos;t claim within {review.escrowTtlDays ?? 14} days, you can refund it (fees for the SMS are not refunded).</p>
          <p className="field-help">PingApp&apos;s signer authorizes claims after phone verification. A compromised signer could redirect unclaimed funds.</p>
        </>}
        {recipientWarnings(recipient).map((warning) => (
          <p className="send-warning" key={warning}>
            {warning}
          </p>
        ))}
        <label className="check-row">
          <Checkbox checked={checked} onCheckedChange={(value) => setChecked(value === true)} />
          <span>{escrow ? "I checked the phone number, fees and escrow terms." : "I checked the recipient and the full address."}</span>
        </label>
        {recipient.underReview && (
          <label className="check-row">
            <Checkbox
              checked={confirmedReview}
              onCheckedChange={(value) => setConfirmedReview(value === true)}
            />
            <span>I confirmed this address with the recipient directly.</span>
          </label>
        )}
        <button
          className="button accent"
          type="button"
          disabled={busy || !checked || (recipient.underReview && !confirmedReview)}
          onClick={onConfirm}
        >
          {busy ? "Checking and opening your wallet…" : "Continue in wallet"}{" "}
          <ArrowUpRight size={16} />
        </button>
      </DialogContent>
    </Dialog>
  );
}
