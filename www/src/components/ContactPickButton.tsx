import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Contact } from "lucide-react";
import { getCountries, parsePhoneNumberWithError, type CountryCode } from "libphonenumber-js";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";
import { platform, PlatformError, type ContactPhone } from "@/platform";
import { qk } from "@/api/hooks";
import type { Me } from "@/api/types";

type Props = {
  country?: CountryCode;
  disabled?: boolean;
  onPick: (contact: { name: string; e164: string }) => void;
};

function localeCountry(): CountryCode | undefined {
  try {
    const region = new Intl.Locale(navigator.language).region as CountryCode | undefined;
    return region && getCountries().includes(region) ? region : undefined;
  } catch {
    return undefined;
  }
}

export default function ContactPickButton(props: Props) {
  return platform.isNative ? <NativeContactPickButton {...props} /> : null;
}

function NativeContactPickButton({ country, disabled, onPick }: Props) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [contact, setContact] = useState<ContactPhone | null>(null);
  const active = useRef(false);
  const picking = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  function select(picked: ContactPhone, number: string) {
    try {
      const linkedCountry = queryClient.getQueryData<Me | null>(qk.session)?.phone?.country;
      const fallback =
        country ??
        (linkedCountry && getCountries().includes(linkedCountry as CountryCode)
          ? (linkedCountry as CountryCode)
          : localeCountry());
      const phone = parsePhoneNumberWithError(number, fallback);
      if (!phone.isValid()) throw new Error("Invalid phone number");
      onPick({ name: picked.name, e164: phone.number });
      setContact(null);
    } catch {
      toast.error("Can't use this number");
    }
  }

  async function pick() {
    if (disabled || picking.current) return;
    picking.current = true;
    setBusy(true);
    try {
      const picked = await platform.pickContactPhone();
      if (!active.current || !picked) return;
      if (!picked.phones.length) toast.error("This contact has no phone number");
      else if (picked.phones.length === 1) select(picked, picked.phones[0].number);
      else setContact(picked);
    } catch (error) {
      if (!active.current) return;
      if (error instanceof PlatformError && error.code === "permission_denied") {
        toast.error("Allow contacts access to pick a phone number", {
          action: {
            label: "Open settings",
            onClick: () => {
              void platform.openAppSettings().catch(() =>
                toast.error("Open your device Settings and allow contacts access for PingApp"),
              );
            },
          },
        });
      } else if (!(error instanceof PlatformError && error.code === "cancelled")) {
        toast.error("Could not open contacts. Please try again.");
      }
    } finally {
      picking.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="icon-button h-12 w-12 shrink-0"
        aria-label="Pick from contacts"
        disabled={disabled || busy}
        onClick={() => void pick()}
      >
        <Contact size={20} />
      </button>
      <Sheet open={!!contact} onOpenChange={(open) => !open && setContact(null)}>
        <SheetContent side="bottom" className="max-h-[70dvh] overflow-y-auto rounded-t-2xl pb-8">
          <SheetHeader>
            <SheetTitle>Choose a phone number</SheetTitle>
            <SheetDescription>{contact?.name || "This contact"} has more than one number.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-2 px-4">
            {contact?.phones.map((phone, index) => (
              <button
                key={index}
                type="button"
                className="button outline flex-col items-start whitespace-normal text-left"
                onClick={() => select(contact, phone.number)}
              >
                <span>{phone.label || "Phone"}</span>
                <span className="break-all" dir="ltr">{phone.number}</span>
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
