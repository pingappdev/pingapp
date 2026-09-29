import { ArrowUpRight, Copy, Plus, Search, Trash2, Users } from "lucide-react";
import { useDashboard } from "../state";
import Empty from "../components/Empty";
import { trimAddress } from "../format";

export default function Contacts() {
  const { contacts, query, setQuery, filtered, setRemove, copy, setModal } = useDashboard();

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
          {contacts.length} {contacts.length === 1 ? "contact" : "contacts"}
        </span>
      </div>
      {filtered.length ? (
        <div className="contact-grid">
          {filtered.map((contact) => (
            <section className="card contact-card" key={contact.id}>
              <div className="panel-heading">
                <span className="contact-initial">{contact.name[0]}</span>
                <button
                  className="icon-button"
                  aria-label={"Delete " + contact.name}
                  onClick={() => setRemove(contact)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <h2>{contact.name}</h2>
              <p>{contact.phone}</p>
              <span className="pill">Saved contact · Not phone verified</span>
              <button className="address-copy" onClick={() => copy(contact.address)}>
                {trimAddress(contact.address)}
                <Copy size={14} />
              </button>
              <a
                href={"/dashboard/send?to=" + encodeURIComponent(contact.phone)}
                className="button outline"
              >
                Send crypto <ArrowUpRight size={16} />
              </a>
            </section>
          ))}
        </div>
      ) : (
        <Empty
          icon={<Users />}
          title={query ? "No matching contacts." : "No saved contacts"}
          text={
            query
              ? "Try a different name, phone number, or address."
              : "Add a contact with their name, international phone number, and wallet address."
          }
          action={
            <button className="button accent" onClick={() => setModal("contact")}>
              <Plus size={17} />
              Add contact
            </button>
          }
        />
      )}
      <p className="panel-footnote">
        Your contact book is private to your account. A saved number does not verify phone
        ownership.
      </p>
    </>
  );
}
