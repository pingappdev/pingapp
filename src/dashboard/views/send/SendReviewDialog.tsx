import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
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
          Confirm the recipient and full address, then approve the request in your wallet.
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
          <dt>Full address</dt>
          <dd>
            <AddressText value={recipient.address} full />
          </dd>
          <dt>Network</dt>
          <dd>Robinhood Chain</dd>
          <dt>Network fee</dt>
          <dd>Shown in your wallet</dd>
        </dl>
        {recipientWarnings(recipient).map((warning) => (
          <p className="send-warning" key={warning}>
            {warning}
          </p>
        ))}
        <label className="check-row">
          <Checkbox checked={checked} onCheckedChange={(value) => setChecked(value === true)} />
          <span>I checked the recipient and the full address.</span>
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
