import { useEffect, useState, type FormEvent } from "react";
import { Plus, Save } from "lucide-react";
import { isValidPhoneNumber } from "libphonenumber-js";
import { isAddress, zeroAddress } from "viem";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useCreateContact, useUpdateContact } from "../../api/hooks";
import type { Contact, ContactCreateInput } from "../../api/types";
import PhoneInput from "./PhoneInput";

export default function ContactDialog({
  open,
  contact,
  onClose,
}: {
  open: boolean;
  contact: Contact | null;
  onClose: () => void;
}) {
  const create = useCreateContact();
  const update = useUpdateContact();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const busy = create.isPending || update.isPending;

  useEffect(() => {
    if (!open) return;
    setName(contact?.name ?? "");
    setPhone(contact?.phone ?? "");
    setAddress(contact?.address ?? "");
    setError("");
  }, [open, contact]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const cleanName = name.trim();
    const cleanAddress = address.trim();
    const cleanPhone = phone.trim();
    if (!cleanName) return setError("Enter a name.");
    if (cleanName.length > 80) return setError("Names can be at most 80 characters.");
    if (!cleanPhone && !cleanAddress)
      return setError("Add a phone number, a wallet address, or both.");
    if (cleanPhone && !isValidPhoneNumber(cleanPhone))
      return setError("Enter a valid phone number.");
    if (
      cleanAddress &&
      (!isAddress(cleanAddress) || cleanAddress.toLowerCase() === zeroAddress.toLowerCase())
    )
      return setError("Enter a valid, non-zero wallet address with the correct checksum.");
    setError("");
    try {
      if (contact) {
        await update.mutateAsync({
          id: contact.id,
          input: { name: cleanName, phone: cleanPhone || null, address: cleanAddress || null },
        });
      } else {
        const input: ContactCreateInput = cleanPhone
          ? {
              name: cleanName,
              phone: cleanPhone,
              ...(cleanAddress ? { address: cleanAddress } : {}),
            }
          : { name: cleanName, address: cleanAddress };
        await create.mutateAsync(input);
      }
      toast.success(contact ? "Contact updated" : "Contact added");
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this contact.");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="ping-dialog">
        <DialogTitle>{contact ? "Edit contact" : "Add a contact"}</DialogTitle>
        <DialogDescription>Keep a private address book for people you send to.</DialogDescription>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="contact-name">Name</label>
          <input
            id="contact-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="Contact name"
            disabled={busy}
            required
          />
          <label>
            Phone number (optional)
            <PhoneInput
              value={phone || undefined}
              onChange={(value) => setPhone(value ?? "")}
              disabled={busy}
              placeholder="+60 12 345 6789"
            />
          </label>
          <label htmlFor="contact-address">Wallet address (optional)</label>
          <input
            id="contact-address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder="0x…"
            disabled={busy}
          />
          <p className="field-help">Add a phone number, a wallet address, or both.</p>
          {error && (
            <p className="field-help contact-form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button accent" type="submit" disabled={busy}>
            {contact ? <Save size={16} /> : <Plus size={16} />}
            {busy ? "Saving…" : contact ? "Save changes" : "Add contact"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
