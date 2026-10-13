import { ChevronRight, History, Phone, Users } from "lucide-react";
import { useAuth } from "../../../auth/useAuth";
import { useContacts, useTransfers } from "../../../api/hooks";

export default function OverviewSummary() {
  const { me } = useAuth();
  const contacts = useContacts();
  const transfers = useTransfers("all");
  const firstPage = transfers.data?.pages[0];

  const contactCount = contacts.data
    ? contacts.data.length.toLocaleString()
    : contacts.isPending
      ? "Loading…"
      : "Unavailable";
  const transferCount = firstPage
    ? `${firstPage.items.length}${firstPage.nextCursor ? "+" : ""}`
    : transfers.isPending
      ? "Loading…"
      : "Unavailable";

  return (
    <div className="workspace-summary" aria-label="Workspace summary">
      <a href="/dashboard/settings">
        <span className="summary-icon">
          <Phone size={18} />
        </span>
        <span>
          <small>Phone</small>
          <strong>{me?.phone ? `Linked · ${me.phone.masked}` : "Not linked"}</strong>
        </span>
        <ChevronRight size={15} />
      </a>
      <a href="/dashboard/contacts">
        <span className="summary-icon">
          <Users size={18} />
        </span>
        <span>
          <small>Saved contacts</small>
          <strong>
            {contactCount}
            {contacts.data && <em>{contacts.data.length === 1 ? "recipient" : "recipients"}</em>}
          </strong>
        </span>
        <ChevronRight size={15} />
      </a>
      <a href="/dashboard/activity">
        <span className="summary-icon">
          <History size={18} />
        </span>
        <span>
          <small>Transfers</small>
          <strong>
            {transferCount}
            {firstPage && <em>{firstPage.nextCursor ? "or more" : "in your activity"}</em>}
          </strong>
        </span>
        <ChevronRight size={15} />
      </a>
    </div>
  );
}
