import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Contact } from "../../../api/types";

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
  const search = value.toLowerCase();
  const digits = search.replace(/\D/g, "");
  const matches = contacts.filter((contact) =>
    contact.name.toLowerCase().includes(search) ||
    (digits && contact.phone?.replace(/\D/g, "").includes(digits)) ||
    contact.address?.toLowerCase().includes(search),
  );
  return (
    <div className="send-recipient-field">
      <label htmlFor="send-recipient">Recipient</label>
      <div className="send-recipient-input">
        <input
          id="send-recipient"
          type="text"
          autoComplete="off"
          value={value}
          disabled={locked}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          placeholder="+60 12 345 6789 or 0x…"
        />
        {!locked && contacts.length > 0 && (
          <Popover open={open && matches.length > 0} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="button outline" aria-label="Choose a saved contact">
                Contacts <ChevronsUpDown size={14} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="send-contact-menu p-0" onOpenAutoFocus={(event) => event.preventDefault()}>
              <Command shouldFilter={false}>
                <CommandList>
                  <CommandEmpty>No saved contacts match.</CommandEmpty>
                  <CommandGroup heading="Saved contacts">
                    {matches.map((contact) => (
                      <CommandItem
                        key={contact.id}
                        value={contact.id}
                        onSelect={() => {
                          onContact(contact);
                          setOpen(false);
                        }}
                      >
                        <span>{contact.name}</span>
                        <small>{contact.phoneMasked ?? contact.phone ?? contact.address}</small>
                      </CommandItem>
                    ))}
                  </CommandGroup>
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
