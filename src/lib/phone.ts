import { parsePhoneNumberWithError } from 'libphonenumber-js/max';
import { AppError } from './errors.js';

export type NormalizedPhone = { e164: string; country: string | null; masked: string };

const formatCharacters = /[\s().-]/g;
const rejectedTypes = new Set(['FIXED_LINE', 'TOLL_FREE', 'PREMIUM_RATE', 'SHARED_COST']);

function invalidPhone(message: string): AppError {
  return new AppError('INVALID_PHONE', 400, message);
}

export function normalizePhone(input: string): NormalizedPhone {
  const normalizedInput = input.replace(formatCharacters, '');

  if (!normalizedInput.startsWith('+')) {
    throw invalidPhone('Enter the number in international format, starting with + and the country code.');
  }

  let phone;
  try {
    phone = parsePhoneNumberWithError(normalizedInput);
  } catch {
    throw invalidPhone('Enter a valid mobile phone number.');
  }

  if (!phone.isValid()) {
    throw invalidPhone('Enter a valid mobile phone number.');
  }

  if (rejectedTypes.has(phone.getType() ?? '')) {
    throw invalidPhone("This doesn't look like a mobile number.");
  }

  const digits = phone.number.slice(1);
  return {
    e164: phone.number,
    country: phone.country ?? null,
    masked: `+${phone.countryCallingCode} ••• ••${digits.slice(-2)}`,
  };
}
