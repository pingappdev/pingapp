import { forwardRef, type ComponentProps, type InputHTMLAttributes } from "react";
import PhoneNumberInput from "react-phone-number-input";
import "react-phone-number-input/style.css";

type Country = NonNullable<ComponentProps<typeof PhoneNumberInput>["defaultCountry"]>;

const StyledInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input {...props} ref={ref} className={`auth-input phone-input-control ${className ?? ""}`} />
  ),
);
StyledInput.displayName = "StyledPhoneInput";

function countryFromLocale(): Country {
  if (typeof navigator === "undefined") return "US" as Country;
  const region = navigator.language.split(/[-_]/)[1]?.toUpperCase();
  return region && /^[A-Z]{2}$/.test(region) ? (region as Country) : ("US" as Country);
}

export default function PhoneInput({
  value,
  onChange,
  defaultCountry,
  placeholder = "Phone number",
  disabled = false,
}: {
  value?: string;
  onChange: (value?: string) => void;
  defaultCountry?: Country;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <PhoneNumberInput
      className="phone-input"
      defaultCountry={defaultCountry ?? countryFromLocale()}
      value={value as ComponentProps<typeof PhoneNumberInput>["value"]}
      onChange={onChange}
      inputComponent={StyledInput}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}
