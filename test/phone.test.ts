import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { normalizePhone } from '../src/lib/phone.js';

describe('normalizePhone', () => {
  it.each([
    ['+420 601 123 456', '+420601123456', 'CZ', '+420 ••• ••56'],
    ['+1 (202) 555-0142', '+12025550142', 'US', '+1 ••• ••42'],
    ['+44 7400 123456', '+447400123456', 'GB', '+44 ••• ••56'],
    ['+49 (1512) 345.6789', '+4915123456789', 'DE', '+49 ••• ••89'],
  ])('normalizes %s', (input, e164, country, masked) => {
    expect(normalizePhone(input)).toEqual({ e164, country, masked });
  });

  it('rejects a US toll-free number', () => {
    expect(() => normalizePhone('+1 800 234 5678')).toThrow("This doesn't look like a mobile number.");
  });

  it('requires a leading plus', () => {
    try {
      normalizePhone('420 601 123 456');
      throw new Error('Expected normalizePhone to reject the input.');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: 'INVALID_PHONE',
        message: 'Enter the number in international format, starting with + and the country code.',
      });
    }
  });

  it('rejects garbage', () => {
    expect(() => normalizePhone('+not a phone')).toThrow(AppError);
  });

  it.each([
    '+12025550142abc',
    '+1 202 555 0142 ext. 123',
  ])('rejects text or extensions after a phone number: %s', (input) => {
    expect(() => normalizePhone(input)).toThrow(AppError);
  });
});
