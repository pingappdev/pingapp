import { describe, expect, it } from 'vitest';
import { canIssueNativeToken, nativeAppOriginsSchema } from '../src/config.js';
import { readSessionToken } from '../src/plugins/auth.js';

const bearer = 'a'.repeat(43);
const cookie = 'b'.repeat(43);
const settings = { NATIVE_APP_ORIGINS: ['https://localhost', 'capacitor://localhost'] };

describe('native session token resolution', () => {
  it('prefers a bearer token over a cookie', () => {
    expect(readSessionToken({ headers: { authorization: `Bearer ${bearer}` }, cookies: { pa_session: cookie } }))
      .toEqual({ token: bearer, via: 'bearer' });
  });

  it.each(['', 'Basic abc', 'Bearer short', `Bearer ${bearer}=`, `Bearer ${bearer} extra`, `Bearer ${'a'.repeat(42)}+`])(
    'rejects malformed Authorization %j without falling back to a cookie', (authorization) => {
      expect(readSessionToken({ headers: { authorization }, cookies: { pa_session: cookie } })).toBeNull();
    },
  );

  it('accepts a case-insensitive bearer scheme and the base64url alphabet', () => {
    const token = `${'a'.repeat(41)}_-`;
    expect(readSessionToken({ headers: { authorization: `bearer ${token}` }, cookies: {} }))
      .toEqual({ token, via: 'bearer' });
  });

  it('uses the cookie when there is no Authorization header', () => {
    expect(readSessionToken({ headers: {}, cookies: { pa_session: cookie } })).toEqual({ token: cookie, via: 'cookie' });
    expect(readSessionToken({ headers: {}, cookies: {} })).toBeNull();
  });
});

describe('native origins', () => {
  it('defaults to disabled and parses a trimmed comma-separated allowlist', () => {
    expect(nativeAppOriginsSchema.parse(undefined)).toEqual([]);
    expect(nativeAppOriginsSchema.parse(' https://localhost, capacitor://localhost, ')).toEqual(settings.NATIVE_APP_ORIGINS);
  });

  it.each(['https://evil.com', 'http://localhost:7400', 'https://localhost/', 'https://localhost.evil.com', 'capacitor://user@localhost']) (
    'rejects non-native origin %s', (origin) => {
      expect(nativeAppOriginsSchema.safeParse(origin).success).toBe(false);
    },
  );

  it('requires an exact configured native origin to issue a token', () => {
    expect(canIssueNativeToken('https://localhost', settings)).toBe(true);
    expect(canIssueNativeToken('capacitor://localhost', settings)).toBe(true);
    for (const origin of [undefined, ['https://localhost'], 'https://evil.com', 'http://localhost:7400', 'https://localhost/']) {
      expect(canIssueNativeToken(origin, settings)).toBe(false);
    }
    expect(canIssueNativeToken('https://localhost', { NATIVE_APP_ORIGINS: [] })).toBe(false);
  });
});
