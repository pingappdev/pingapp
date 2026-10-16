import { ArrowUpRight, Users } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useContacts } from "../../../api/hooks";
import { contactMembershipLabel, contactMembershipStatus } from "../../contactMembership";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Saved recipients are unavailable.";
}

function PingAppIndicator({ label }: { label: string }) {
  return (
    <span className="pill" title="On PingApp">
      <span className="pill-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export default function SavedRecipients() {
  const contacts = useContacts();
  const recipients = contacts.data?.slice(0, 3) ?? [];

  return (
    <section className="card contacts-preview">
      <div className="panel-heading">
        <h2>Saved recipients</h2>
        <a href="/dashboard/contacts" aria-label="View all contacts">
          <ArrowUpRight size={18} />
        </a>
      </div>
      {contacts.isPending && !contacts.data ? (
        <div className="space-y-4" aria-label="Loading contacts" aria-busy="true">
          {[0, 1, 2].map((row) => (
            <Skeleton className="h-12 w-full" key={row} />
          ))}
        </div>
      ) : contacts.error && !contacts.data ? (
        <div role="alert">
          <p>{errorText(contacts.error)}</p>
          <button type="button" className="text-link" onClick={() => void contacts.refetch()}>
            Refresh
          </button>
        </div>
      ) : recipients.length > 0 ? (
        <>
          {contacts.error && (
            <p className="field-help" role="alert">
              {errorText(contacts.error)}
            </p>
          )}
          {recipients.map((contact) => (
            <a
              className="contact-mini"
              key={contact.id}
              href={`/dashboard/send?contact=${encodeURIComponent(contact.id)}`}
            >
              <span className="contact-initial">{[...contact.name][0] ?? "?"}</span>
              <span>
                <strong>{contact.name}</strong>
                <small>{contact.phoneMasked}</small>
                {contactMembershipStatus(contact) === "registered" ? (
                  <PingAppIndicator label={contactMembershipLabel(contact)} />
                ) : (
                  <small>{contactMembershipLabel(contact)}</small>
                )}
              </span>
              <ArrowUpRight size={17} />
            </a>
          ))}
        </>
      ) : (
        <div className="empty-compact">
          {contacts.error && <p role="alert">{errorText(contacts.error)}</p>}
          <Users size={26} />
          <h3>Your address book</h3>
          <p>Save contacts with phone numbers for quicker transfers.</p>
          <a className="text-link" href="/dashboard/contacts">
            Manage contacts <ArrowUpRight size={15} />
          </a>
        </div>
      )}
    </section>
  );
}
