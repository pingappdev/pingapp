import { useEffect, useState, type FormEvent } from "react";
import { Plus, Save } from "lucide-react";
import { isValidPhoneNumber, type CountryCode } from "libphonenumber-js";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import ContactPickButton from "@/components/ContactPickButton";
import { useCreateContact, useUpdateContact } from "../../api/hooks";
import type { Contact } from "../../api/types";
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
  const [error, setError] = useState("");
  const [country, setCountry] = useState<CountryCode>();
  const busy = create.isPending || update.isPending;

  useEffect(() => {
    if (!open) return;
    setName(contact?.name ?? "");
    setPhone(contact?.phone ?? "");
    setError("");
  }, [open, contact]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const cleanName = name.trim();
    const cleanPhone = phone.trim();
    if (!cleanName) return setError("Enter a name.");
    if (cleanName.length > 80) return setError("Names can be at most 80 characters.");
    if (!cleanPhone) return setError("Add a phone number.");
    if (!isValidPhoneNumber(cleanPhone)) return setError("Enter a valid phone number.");
    setError("");
    try {
      if (contact) {
        await update.mutateAsync({ id: contact.id, input: { name: cleanName, phone: cleanPhone } });
      } else {
        await create.mutateAsync({ name: cleanName, phone: cleanPhone });
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
        <DialogDescription>Save the phone numbers of people you send to.</DialogDescription>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="contact-name">Name</label>
          <input
            id="contact-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="Contact name"
            disabled={busy}
            onCountryChange={setCountry}
            accessory={
              <ContactPickButton
                country={country}
                disabled={busy}
                onPick={(picked) => {
                  setName((current) => (current.trim() ? current : picked.name.slice(0, 80)));
                  setPhone(picked.e164);
                  setError("");
                }}
              />
            }
            required
          />
          <label htmlFor="contact-phone">Phone number</label>
          <PhoneInput
            id="contact-phone"
            value={phone || undefined}
            onChange={(value) => setPhone(value ?? "")}
            disabled={busy}
          />
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
