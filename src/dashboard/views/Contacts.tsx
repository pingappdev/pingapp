import { useState } from "react";
import { ArrowUpRight, Pencil, Plus, Search, Trash2, Users } from "lucide-react";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { useContacts } from "../../api/hooks";
import type { Contact } from "../../api/types";
import AddressText from "../components/AddressText";
import Empty from "../components/Empty";

function international(phone: string | null): string | null {
  if (!phone) return null;
  try {
    return parsePhoneNumberFromString(phone)?.formatInternational() ?? phone;
  } catch {
    return phone;
  }
}

export default function Contacts({
  onAdd,
  onEdit,
  onRemove,
}: {
  onAdd: () => void;
  onEdit: (contact: Contact) => void;
  onRemove: (contact: Contact) => void;
}) {
  const [query, setQuery] = useState("");
  const contacts = useContacts();
  const search = query.trim().toLowerCase();
  const digits = search.replace(/\D/g, "");
  const filtered = (contacts.data ?? []).filter(
    (contact) =>
      contact.name.toLowerCase().includes(search) ||
      contact.address?.toLowerCase().includes(search) ||
      contact.onPingApp?.address.toLowerCase().includes(search) ||
      (digits.length > 0 &&
        [contact.phone, contact.phoneMasked].some((value) =>
          value?.replace(/\D/g, "").includes(digits),
        )),
  );

  return (
    <>
      <div className="toolbar">
        <label className="input-icon">
          <Search size={17} />
          <input
            aria-label="Search contacts"
            placeholder="Search name, phone, or wallet"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span>
          {contacts.data?.length ?? 0} {(contacts.data?.length ?? 0) === 1 ? "contact" : "contacts"}
        </span>
      </div>
      {contacts.isPending ? (
        <div className="workspace-loading" role="status">
          Loading contacts…
        </div>
      ) : contacts.isError ? (
        <div className="error-panel" role="alert">
          <h2>Contacts could not load.</h2>
          <p>{contacts.error instanceof Error ? contacts.error.message : "Try again."}</p>
          <button className="button outline" onClick={() => void contacts.refetch()}>
            Try again
          </button>
        </div>
      ) : filtered.length ? (
        <div className="contact-grid">
          {filtered.map((contact) => {
            const mismatch =
              !!contact.address &&
              !!contact.onPingApp &&
              contact.address.toLowerCase() !== contact.onPingApp.address.toLowerCase();
            const displayAddress = contact.address ?? contact.onPingApp?.address;
            return (
              <section className="card contact-card" key={contact.id}>
                <div className="panel-heading">
                  <span className="contact-initial">{contact.name.charAt(0).toUpperCase()}</span>
                  <div className="contact-card-actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Edit ${contact.name}`}
                      onClick={() => onEdit(contact)}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Delete ${contact.name}`}
                      onClick={() => onRemove(contact)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <h2>{contact.name}</h2>
                {contact.phone && <p>{international(contact.phone)}</p>}
                <span className={`pill${contact.onPingApp ? " accent" : ""}`}>
                  {contact.onPingApp
                    ? `On PingApp · ${contact.onPingApp.displayName || "PingApp user"}`
                    : "Not on PingApp"}
                </span>
                {displayAddress && (
                  <div className="address-copy">
                    <AddressText value={displayAddress} />
                  </div>
                )}
                {mismatch && (
                  <p className="contact-mismatch">
                    Saved address differs from their PingApp wallet. Sending by contact uses the
                    PingApp wallet.
                  </p>
                )}
                <a
                  href={`/dashboard/send?contact=${encodeURIComponent(contact.id)}`}
                  className="button outline"
                >
                  Send <ArrowUpRight size={16} />
                </a>
              </section>
            );
          })}
        </div>
      ) : (
        <Empty
          icon={<Users />}
          title={query ? "No matching contacts." : "No saved contacts"}
          text={
            query
              ? "Try a different name, phone number, or address."
              : "Add a contact with a phone number, a wallet address, or both."
          }
          action={
            <button className="button accent" onClick={onAdd}>
              <Plus size={17} />
              Add contact
            </button>
          }
        />
      )}
      <p className="panel-footnote">
        Your contacts are private to your account. &quot;On PingApp&quot; means the number is
        verified and linked to a wallet.
      </p>
    </>
  );
}
