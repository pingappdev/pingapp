import { AlertTriangle, Check, UserRound } from "lucide-react";
import type { ResolveResponse } from "../../../api/types";
import AddressText from "../../components/AddressText";
import type { Recipient } from "./types";
import { recipientWarnings } from "./types";

export default function RecipientCard({
  recipient,
  resolution,
  resolving,
  error,
  pendingUrl,
}: {
  recipient: Recipient | null;
  resolution?: ResolveResponse | null;
  resolving?: boolean;
  error?: string;
  pendingUrl?: string;
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
            Nothing can be sent to a phone number until its owner links a wallet. You can create a
            pending send: we&apos;ll text them an invite and notify you when they&apos;re ready.
          </p>
          {resolution.canCreateIntent && pendingUrl && (
            <a className="button outline" href={pendingUrl}>
              Create pending send
            </a>
          )}
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
        <AddressText value={recipient.address} full />
        {recipient.linkedAt && (
          <small>On PingApp since {new Date(recipient.linkedAt).toLocaleDateString()}</small>
        )}
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
