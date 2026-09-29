import { forwardRef, type ComponentProps, type InputHTMLAttributes } from "react";
import PhoneNumberInput, { getCountries } from "react-phone-number-input";
import "react-phone-number-input/style.css";
import PhoneCountrySelect from "./PhoneCountrySelect";

type Country = NonNullable<ComponentProps<typeof PhoneNumberInput>["defaultCountry"]>;

const StyledInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, onPaste, onChange, ...props }, ref) => (
    <input
      {...props}
      ref={ref}
      className={`auth-input phone-input-control ${className ?? ""}`}
      onPaste={(event) => {
        event.currentTarget.setCustomValidity("");
        if (/^0x/i.test(event.clipboardData.getData("text").trim())) {
          event.preventDefault();
          event.currentTarget.setCustomValidity(
            "Enter a phone number. Wallet addresses aren't supported here.",
          );
          event.currentTarget.reportValidity();
          return;
        }
        onPaste?.(event);
      }}
      onChange={(event) => {
        event.currentTarget.setCustomValidity("");
        onChange?.(event);
      }}
    />
  ),
);
StyledInput.displayName = "StyledPhoneInput";

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
  return (
    <PhoneNumberInput
      className="phone-input"
      id={id}
      name={name}
      defaultCountry={defaultCountry ?? countryFromLocale()}
      international
      countryCallingCodeEditable={false}
      addInternationalOption={false}
      countrySelectComponent={PhoneCountrySelect}
      countrySelectProps={{ "aria-label": "Country and calling code" }}
      aria-label={id ? undefined : "Phone number"}
      value={value as ComponentProps<typeof PhoneNumberInput>["value"]}
      onChange={onChange}
      inputComponent={StyledInput}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}
