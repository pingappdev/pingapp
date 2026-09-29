import { describe, expect, it } from 'vitest';
import { createCrypto } from '../src/lib/crypto.js';

const keys = {
  hmacKeyHex: '11'.repeat(32),
  encKeyHex: '22'.repeat(32),
};

describe('crypto helpers', () => {
  it('creates deterministic HMAC lookup keys that depend on the secret', () => {
    const first = createCrypto(keys).phoneHmac('+420601123456');
    const sameKey = createCrypto(keys).phoneHmac('+420601123456');
    const otherKey = createCrypto({ ...keys, hmacKeyHex: '33'.repeat(32) }).phoneHmac('+420601123456');

    expect(first).toBe(sameKey);
    expect(first).not.toBe(otherKey);
  });

  it('round-trips encrypted values and rejects tampered ciphertext', () => {
    const crypto = createCrypto(keys);
    const encrypted = crypto.encrypt('+420601123456');

    expect(crypto.decrypt(encrypted)).toBe('+420601123456');
    const bytes = Buffer.from(encrypted, 'base64');
    bytes[bytes.length - 1] ^= 1;
    expect(() => crypto.decrypt(bytes.toString('base64'))).toThrow();
  });

  it('generates base62 codes with the requested length and six-digit OTPs', () => {
    const crypto = createCrypto(keys);
    const code = crypto.randomCode(24);

    expect(code).toHaveLength(24);
    expect(code).toMatch(/^[0-9A-Za-z]+$/);
    expect(crypto.randomOtp()).toMatch(/^\d{6}$/);
  });
});
