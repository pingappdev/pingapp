export type ErrorCode =
  | 'VALIDATION' | 'INVALID_PHONE' | 'INVALID_ADDRESS' | 'INVALID_AMOUNT'
  | 'AMOUNT_TOO_SMALL' | 'UNKNOWN_TOKEN' | 'OTP_INVALID' | 'OTP_EXPIRED'
  | 'DISPLAY_NAME_REQUIRED' | 'SELF_SEND' | 'UNAUTHENTICATED' | 'SIWE_INVALID'
  | 'CSRF' | 'REAUTH_REQUIRED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'PHONE_LINKED_ELSEWHERE' | 'CLAIM_PENDING' | 'CONFLICT' | 'INTENT_NOT_OPEN'
  | 'ACCOUNT_CHANGED' | 'CARD_PROFILE_CHANGED' | 'USE_ESCROW'
  | 'CARDS_UNAVAILABLE' | 'CARD_EMAIL_REQUIRED' | 'CARD_NOT_READY' | 'APPLE_PAY_UNSUPPORTED' | 'APPLE_PAY_BUSY' | 'CARD_ALREADY_EXISTS'
  | 'CARD_OPERATION_PENDING' | 'IDEMPOTENCY_CONFLICT' | 'CARD_ACCOUNT_ACTIVE'
  | 'RATE_LIMITED' | 'SMS_UNAVAILABLE' | 'UPSTREAM_UNAVAILABLE' | 'INTERNAL';

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    public status: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

type Details = Record<string, unknown>;
const error = (code: ErrorCode, status: number, message: string, details?: Details) =>
  new AppError(code, status, message, details);

export const errors = {
  validation: (message = 'Invalid request.', details?: Details) => error('VALIDATION', 400, message, details),
  invalidPhone: (message = 'Enter a valid mobile phone number.', details?: Details) => error('INVALID_PHONE', 400, message, details),
  invalidAddress: (message = 'Enter a valid wallet address.', details?: Details) => error('INVALID_ADDRESS', 400, message, details),
  invalidAmount: (message = 'Enter a valid amount.', details?: Details) => error('INVALID_AMOUNT', 400, message, details),
  amountTooSmall: (message: string, details?: Details) => error('AMOUNT_TOO_SMALL', 400, message, details),
  unknownToken: (message = 'This token is unavailable.') => error('UNKNOWN_TOKEN', 400, message),
  otpInvalid: (attemptsLeft: number) => error('OTP_INVALID', 400, 'Invalid code.', { attemptsLeft }),
  otpExpired: () => error('OTP_EXPIRED', 400, 'Code expired. Request a new one.'),
  displayNameRequired: () => error('DISPLAY_NAME_REQUIRED', 400, 'Set a display name first.'),
  selfSend: () => error('SELF_SEND', 400, 'You cannot send to yourself.'),
  unauthenticated: () => error('UNAUTHENTICATED', 401, 'Please sign in.'),
  siweInvalid: () => error('SIWE_INVALID', 401, 'Wallet sign-in failed. Please try again.'),
  csrf: () => error('CSRF', 403, 'Request blocked.'),
  reauthRequired: () => error('REAUTH_REQUIRED', 403, 'Confirm this action with your wallet.'),
  forbidden: () => error('FORBIDDEN', 403, 'You cannot access this resource.'),
  notFound: (message = 'Not found.') => error('NOT_FOUND', 404, message),
  phoneLinkedElsewhere: (claimId: string, support: string) => error('PHONE_LINKED_ELSEWHERE', 409, 'This number is linked to another wallet.', { claimId, support }),
  claimPending: () => error('CLAIM_PENDING', 409, 'A claim is already under review for this number.'),
  conflict: (message: string, details?: Details) => error('CONFLICT', 409, message, details),
  intentNotOpen: () => error('INTENT_NOT_OPEN', 409, 'This pending send is no longer open.'),
  rateLimited: (retryAfterSec: number) => {
    const isSeconds = retryAfterSec < 60;
    const amount = isSeconds ? retryAfterSec : Math.ceil(retryAfterSec / 60);
    const unit = isSeconds ? (amount === 1 ? 'second' : 'seconds') : (amount === 1 ? 'minute' : 'minutes');
    const interval = `${amount} ${unit}`;
    return error('RATE_LIMITED', 429, `Too many attempts. Try again in ${interval}.`, { retryAfterSec });
  },
  smsUnavailable: () => error('SMS_UNAVAILABLE', 503, 'SMS is unavailable. Please try again later.'),
  upstreamUnavailable: () => error('UPSTREAM_UNAVAILABLE', 503, 'Service temporarily unavailable. Please try again.'),
  internal: () => error('INTERNAL', 500, 'Something went wrong. Please try again.'),
};
