import { ArrowUpRight } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useDashboard } from "../state";
import NetworkLabel from "./NetworkLabel";

export default function ReviewDialog() {
  const {
    review,
    setReview,
    busy,
    amount,
    network,
    currentContact,
    destination,
    profile,
    approved,
    setApproved,
    sendTransaction,
  } = useDashboard();

  return (
    <Dialog
      open={review}
      onOpenChange={(open) => {
        if (!busy) setReview(open);
      }}
    >
      <DialogContent className="ping-dialog">
        <DialogTitle>Review your transfer</DialogTitle>
        <DialogDescription>
          Confirm the destination, then approve the request in your wallet.
        </DialogDescription>
        <div className="review-amount">
          {amount} <span>ETH</span>
        </div>
        <dl className="review-details">
          <dt>Network</dt>
          <dd>
            <NetworkLabel _network={network} />
          </dd>
          <dt>Recipient</dt>
          <dd>{currentContact?.name ?? "Wallet address"}</dd>
          <dt>Address</dt>
          <dd className="break-all">{destination}</dd>
          <dt>Network fee</dt>
          <dd>Calculated by your wallet</dd>
        </dl>
        {!!profile.confirm_transfers && (
          <p className="field-help">
            Review this address with the recipient. Transfers cannot be reversed by PingApp.
          </p>
        )}
        <label className="check-row">
          <Checkbox
            checked={approved}
            onCheckedChange={(value) => setApproved(value === true)}
            aria-label="I checked the recipient address"
          />
          <span>I checked the full address and selected network.</span>
        </label>
        <button className="button accent" onClick={sendTransaction} disabled={!approved || busy}>
          {busy ? "Check your wallet…" : "Continue in wallet"}
          <ArrowUpRight size={16} />
        </button>
      </DialogContent>
    </Dialog>
  );
}
