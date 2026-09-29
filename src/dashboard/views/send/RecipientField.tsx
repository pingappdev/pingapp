import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Contact } from "../../../api/types";
import PhoneInput from "../../components/PhoneInput";

export default function RecipientField({
  value,
  onChange,
  onContact,
  contacts,
  formattedPhone,
  locked,
}: {
  value: string;
  onChange: (value: string) => void;
  onContact: (contact: Contact) => void;
  contacts: Contact[];
  formattedPhone?: string;
  locked?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const digits = search.replace(/\D/g, "");
  const matches = contacts.filter(
    (contact) =>
      contact.phone &&
      (contact.name.toLowerCase().includes(search.toLowerCase()) ||
        (digits && contact.phone.replace(/\D/g, "").includes(digits))),
  );
  const phoneContacts = contacts.some((contact) => !!contact.phone);

  return (
    <div className="send-recipient-field">
      <label htmlFor="send-recipient">Recipient phone number</label>
      <div className="send-recipient-input">
        <PhoneInput
          id="send-recipient"
          value={value}
          onChange={(next) => onChange(next ?? "")}
          disabled={locked}
        />
        {!locked && phoneContacts && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="button outline" aria-label="Choose a saved contact">
                Contacts <ChevronsUpDown size={14} />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="send-contact-menu p-0"
              onOpenAutoFocus={(event) => event.preventDefault()}
            >
              <Command shouldFilter={false}>
                <CommandInput
                  value={search}
                  onValueChange={setSearch}
                  placeholder="Search contacts by name or phone"
                  aria-label="Search phone contacts"
                />
                <CommandList>
                  {matches.length === 0 ? (
                    <CommandEmpty>No phone contacts match.</CommandEmpty>
                  ) : (
                    <CommandGroup heading="Saved contacts">
                      {matches.map((contact) => (
                        <CommandItem
                          key={contact.id}
                          value={contact.id}
                          onSelect={() => {
                            onContact(contact);
                            setSearch("");
                            setOpen(false);
                          }}
                        >
                          <span>{contact.name}</span>
                          <small>{contact.phoneMasked ?? contact.phone}</small>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}
      </div>
      {formattedPhone && <p className="field-help">International: {formattedPhone}</p>}
    </div>
  );
}
