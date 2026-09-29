import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";

export type PhoneDraft = { country: CountryCode; text: string; value?: string };

const countries = getCountries();

function internationalParts(text: string, preferred: CountryCode) {
  if (!/^\+[\d\s().-]*$/.test(text)) return null;
  const digits = text.replace(/\D/g, "");
  const matching = countries.filter((country) => digits.startsWith(getCountryCallingCode(country)));
  if (!matching.length) return null;
  const parsed = parsePhoneNumberFromString(`+${digits}`, { extract: false });
  const country =
    parsed?.country ??
    (matching.includes(preferred) ? preferred : matching.length === 1 ? matching[0] : undefined);
  if (!country) return null;
  return { country, parsed, national: digits.slice(getCountryCallingCode(country).length) };
}

/** Keep international drafts intact until a complete number or an explicit blur. */
export function editPhoneDraft(text: string, country: CountryCode, commit = false): PhoneDraft {
  text = text.trimStart();
  if (text.startsWith("+")) {
    const parts = internationalParts(text, country);
    if (parts && (parts.parsed?.isValid() || commit)) {
      const value = parts.parsed?.isValid()
        ? parts.parsed.number
        : parts.national
          ? `+${getCountryCallingCode(parts.country)}${parts.national}`
          : undefined;
      return {
        country: parts.country,
        text: parts.parsed?.isValid() ? parts.parsed.formatNational() : parts.national,
        value,
      };
    }
    // Do not publish a partial international draft as a number in the old country.
    return { country, text, value: undefined };
  }
  if (!/^[\d\s().-]*$/.test(text)) return { country, text, value: undefined };
  const formatter = new AsYouType(country);
  formatter.input(text);
  const value = formatter.getNumberValue();
  const parsed = value ? parsePhoneNumberFromString(value, { extract: false }) : undefined;
  return { country, text: commit && parsed?.isValid() ? parsed.formatNational() : text, value };
}

export function phoneDraftFromValue(value: string | undefined, preferred: CountryCode): PhoneDraft {
  if (!value) return { country: preferred, text: "", value: undefined };
  const parts = internationalParts(value, preferred);
  return parts
    ? { country: parts.country, text: parts.parsed?.formatNational() ?? parts.national, value }
    : { country: preferred, text: value, value };
}

export function changePhoneCountry(draft: PhoneDraft, country: CountryCode): PhoneDraft {
  const text = draft.text.startsWith("+")
    ? (internationalParts(draft.text, draft.country)?.national ?? "")
    : draft.text;
  return editPhoneDraft(text, country);
}
