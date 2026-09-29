import { useRef, useState } from "react";
import { getCountries, type Country } from "react-phone-number-input";
import labels from "react-phone-number-input/locale/en";
import "react-phone-number-input/style.css";
import PhoneCountrySelect from "./PhoneCountrySelect";
import {
  changePhoneCountry,
  editPhoneDraft,
  phoneDraftFromValue,
  type PhoneDraft,
} from "./phoneInputValue";

const countryOptions = getCountries()
  .map((value) => ({ value, label: labels[value] }))
  .sort((a, b) => a.label.localeCompare(b.label));

function countryFromLocale(): Country {
  if (typeof navigator !== "undefined") {
    try {
      const region = new Intl.Locale(navigator.language).region as Country | undefined;
      if (region && getCountries().includes(region)) return region;
    } catch {
      // Fall back when the browser does not expose a supported region.
    }
  }
  return "US";
}

export default function PhoneInput({
  value,
  onChange,
  defaultCountry,
  id,
  name,
  placeholder = "Phone number",
  disabled = false,
}: {
  value?: string;
  onChange: (value?: string) => void;
  defaultCountry?: Country;
  id?: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const controlledValue = value || undefined;
  const [draft, setDraft] = useState(() =>
    phoneDraftFromValue(controlledValue, defaultCountry ?? countryFromLocale()),
  );

  // Parent echoes retain the editing draft; contact prefills and resets replace it.
  if (controlledValue !== draft.value) {
    setDraft(phoneDraftFromValue(controlledValue, draft.country));
  }

  function publish(next: PhoneDraft) {
    setDraft(next);
    if (next.value !== controlledValue) onChange(next.value);
  }

  return (
    <div className={`PhoneInput phone-input${disabled ? " PhoneInput--disabled" : ""}`}>
      <PhoneCountrySelect
        value={draft.country}
        options={countryOptions}
        onChange={(country) => {
          input.current?.setCustomValidity("");
          publish(changePhoneCountry(draft, country));
          input.current?.focus();
        }}
        name={name ? `${name}Country` : undefined}
        aria-label="Country and calling code"
        disabled={disabled}
      />
      <input
        ref={input}
        className="auth-input phone-input-control PhoneInputInput"
        id={id}
        name={name}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        dir="ltr"
        aria-label={id ? undefined : "Phone number"}
        value={draft.text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          event.currentTarget.setCustomValidity("");
          publish(editPhoneDraft(event.target.value, draft.country));
        }}
        onBlur={() => publish(editPhoneDraft(draft.text, draft.country, true))}
        onPaste={(event) => {
          event.currentTarget.setCustomValidity("");
          if (/^0x/i.test(event.clipboardData.getData("text").trim())) {
            event.preventDefault();
            event.currentTarget.setCustomValidity(
              "Enter a phone number. Wallet addresses aren't supported here.",
            );
            event.currentTarget.reportValidity();
          }
        }}
      />
    </div>
  );
}
