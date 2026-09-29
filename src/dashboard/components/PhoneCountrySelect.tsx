import type { ComponentType, SelectHTMLAttributes } from "react";
import { getCountryCallingCode, type Country } from "react-phone-number-input";

type CountryOption = { value?: Country; label: string; divider?: boolean };
type CountrySelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> & {
  value?: Country;
  onChange: (country: Country) => void;
  options: CountryOption[];
  iconComponent?: ComponentType<{ country?: Country; label: string }>;
  readOnly?: boolean;
};

export default function PhoneCountrySelect({
  value,
  onChange,
  options,
  iconComponent: Icon = CountryFlag,
  className,
  disabled,
  readOnly,
  ...props
}: CountrySelectProps) {
  const selected = options.find((option) => option.value === value);
  return (
    <div className="PhoneInputCountry">
      <select
        {...props}
        className={`PhoneInputCountrySelect ${className ?? ""}`}
        value={value ?? ""}
        disabled={disabled || readOnly}
        onChange={(event) => onChange(event.target.value as Country)}
      >
        {options.map((option) =>
          option.value && !option.divider ? (
            <option key={option.value} value={option.value}>
              {option.label} (+{getCountryCallingCode(option.value)})
            </option>
          ) : null,
        )}
      </select>
      {value && (
        <>
          <Icon country={value} label={selected?.label ?? value} aria-hidden="true" />
          <span className="phone-country-code" aria-hidden="true">
            +{getCountryCallingCode(value)}
          </span>
        </>
      )}
      <span className="PhoneInputCountrySelectArrow" aria-hidden="true" />
    </div>
  );
}

function CountryFlag({ country, label }: { country?: Country; label: string }) {
  return (
    <span className="PhoneInputCountryIcon" aria-hidden="true">
      <img
        className="PhoneInputCountryIconImg"
        src={`https://purecatamphetamine.github.io/country-flag-icons/3x2/${country}.svg`}
        alt={label}
      />
    </span>
  );
}
