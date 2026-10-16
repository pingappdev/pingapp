import type { Contact, ContactMembershipStatus } from "../api/types";

export function contactMembershipStatus(contact: Contact): ContactMembershipStatus {
  if (contact.membershipStatus) return contact.membershipStatus;
  // Older APIs returned only onPingApp. A null value did not prove that the
  // contact was unregistered, so preserve uncertainty during rolling deploys.
  return contact.onPingApp ? "registered" : "unknown";
}

export function contactMembershipLabel(contact: Contact): string {
  switch (contactMembershipStatus(contact)) {
    case "registered":
      return `On PingApp · ${contact.onPingApp?.displayName || "PingApp user"}`;
    case "not_registered":
      return "Not on PingApp";
    case "unknown":
      return "Check when sending";
  }
}
