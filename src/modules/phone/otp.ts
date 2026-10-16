import { sha256Hex, timingSafeEqualHex } from '../../lib/crypto.js';

export type OtpState = {
  phoneHmac: string;
  codeHash: string;
  attempts: number;
  createdAt: number;
  generation?: number;
};

export type OtpCheck = { result: 'ok' | 'invalid' | 'expired'; state: OtpState | null };

/** Pure decision used before a watched Redis transaction commits the attempt. */
export function checkOtp(state: OtpState | null, phoneHmac: string, userId: string, code: string): OtpCheck {
  if (!state || state.phoneHmac !== phoneHmac || state.attempts >= 5 ||
      Date.now() - state.createdAt >= 600_000) {
    return { result: 'expired', state: null };
  }
  const submittedHash = sha256Hex(`${code}:${phoneHmac}:${userId}`);
  if (timingSafeEqualHex(state.codeHash, submittedHash)) return { result: 'ok', state: null };
  const attempts = state.attempts + 1;
  return attempts >= 5
    ? { result: 'expired', state: null }
    : { result: 'invalid', state: { ...state, attempts } };
}
