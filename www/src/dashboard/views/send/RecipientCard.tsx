import { AlertTriangle, Check, UserRound } from "lucide-react";
import type { ResolveResponse } from "../../../api/types";
import type { Recipient } from "./types";
import { recipientWarnings } from "./types";

export default function RecipientCard({
  recipient,
  resolution,
  resolving,
  error,
  escrowEnabled = false,
}: {
  recipient: Recipient | null;
  resolution?: ResolveResponse | null;
  resolving?: boolean;
  error?: string;
  escrowEnabled?: boolean;
}) {
  if (resolving)
    return (
      <div className="recipient-match send-recipient-card" role="status">
        Looking up this number…
      </div>
    );
  if (error)
    return (
      <p className="field-help send-error" role="alert">
        {error}
      </p>
    );
  if (resolution?.status === "not_registered")
    return (
      <div className="recipient-match send-recipient-card">
        <UserRound size={20} />
        <div>
          <strong>{resolution.phoneMasked} isn&apos;t on PingApp yet.</strong>
          <p>
            {escrowEnabled
              ? "Send now — held safely until they join. They can claim after verifying this phone number."
              : "Sending is temporarily unavailable."}
          </p>
        </div>
      </div>
    );
  if (!recipient) return null;
  const warnings = recipientWarnings(recipient);
  return (
    <div className="recipient-match send-recipient-card">
      <span className="send-recipient-avatar">{recipient.name.charAt(0).toUpperCase()}</span>
      <div>
        <strong>{recipient.name}</strong>
        <small>{recipient.phoneMasked ?? "On PingApp"}</small>
        <small>Delivered automatically after your deposit confirms.</small>
        {warnings.map((warning) => (
          <p
            key={warning}
            className={`send-warning${recipient.underReview && warning.includes("under review") ? " urgent" : ""}`}
          >
            {warning.includes("under review") ? <AlertTriangle size={14} /> : <Check size={14} />}
            {warning}
          </p>
        ))}
      </div>
    </div>
  );
}
