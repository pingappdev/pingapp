import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/crypto.js';
import { checkOtp, type OtpState } from '../src/modules/phone/otp.js';

const userId = 'user-a';
const phoneHmac = 'phone-hmac-a';
const code = '123456';
const state = (): OtpState => ({
  phoneHmac,
  codeHash: sha256Hex(`${code}:${phoneHmac}:${userId}`),
  attempts: 0,
  createdAt: Date.now(),
});

describe('OTP decision', () => {
  it('accepts only the issued code, user and phone', () => {
    expect(checkOtp(state(), phoneHmac, userId, code)).toEqual({ result: 'ok', state: null });
    expect(checkOtp(state(), phoneHmac, 'user-b', code).result).toBe('invalid');
    expect(checkOtp(state(), 'phone-hmac-b', userId, code)).toEqual({ result: 'expired', state: null });
  });

  it('counts guesses and burns the fifth', () => {
    let current: OtpState | null = state();
    for (let attempts = 1; attempts <= 5; attempts++) {
      const checked = checkOtp(current, phoneHmac, userId, '000000');
      expect(checked.result).toBe(attempts === 5 ? 'expired' : 'invalid');
      current = checked.state;
      if (attempts < 5) expect(current?.attempts).toBe(attempts);
    }
    expect(current).toBeNull();
  });

  it('expires after ten minutes', () => {
    const old = state();
    old.createdAt -= 600_001;
    expect(checkOtp(old, phoneHmac, userId, code)).toEqual({ result: 'expired', state: null });
  });
});
