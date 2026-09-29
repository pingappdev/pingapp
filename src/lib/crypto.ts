import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config.js';

const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export type CryptoKeys = {
  hmacKeyHex: string;
  encKeyHex: string;
};

function keyFromHex(value: string, name: string): Buffer {
  if (!/^[\da-f]{64}$/i.test(value)) {
    throw new Error(`${name} must be a 32-byte hex key.`);
  }
  return Buffer.from(value, 'hex');
}

function parseBlob(blob: string): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const decoded = Buffer.from(blob, 'base64');
  if (decoded.toString('base64') !== blob || decoded.length < AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES) {
    throw new Error('Invalid encrypted value.');
  }

  return {
    iv: decoded.subarray(0, AES_GCM_IV_BYTES),
    tag: decoded.subarray(AES_GCM_IV_BYTES, AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES),
    ciphertext: decoded.subarray(AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES),
  };
}

export function createCrypto(keys: CryptoKeys) {
  const hmacKey = keyFromHex(keys.hmacKeyHex, 'PHONE_HMAC_SECRET');
  const encryptionKey = keyFromHex(keys.encKeyHex, 'PHONE_ENC_KEY');

  return {
    phoneHmac(e164: string): string {
      return createHmac('sha256', hmacKey).update(e164, 'utf8').digest('hex');
    },

    encrypt(plain: string): string {
      const iv = randomBytes(AES_GCM_IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
      return payload.toString('base64');
    },

    decrypt(blob: string): string {
      const { iv, tag, ciphertext } = parseBlob(blob);
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },

    sha256Hex(s: string): string {
      return createHash('sha256').update(s, 'utf8').digest('hex');
    },

    randomToken(bytes = 32): string {
      return randomBytes(bytes).toString('base64url');
    },

    randomCode(len = 10): string {
      if (!Number.isSafeInteger(len) || len < 0) {
        throw new RangeError('Code length must be a non-negative integer.');
      }

      let code = '';
      for (let index = 0; index < len; index += 1) {
        code += BASE62[randomInt(BASE62.length)];
      }
      return code;
    },

    randomOtp(): string {
      return randomInt(0, 1_000_000).toString().padStart(6, '0');
    },

    timingSafeEqualHex(a: string, b: string): boolean {
      if (!/^(?:[\da-f]{2})+$/i.test(a) || !/^(?:[\da-f]{2})+$/i.test(b) || a.length !== b.length) {
        return false;
      }
      return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
    },
  };
}

const defaultCrypto = createCrypto({
  hmacKeyHex: config.PHONE_HMAC_SECRET,
  encKeyHex: config.PHONE_ENC_KEY,
});

export const phoneHmac = defaultCrypto.phoneHmac;
export const encrypt = defaultCrypto.encrypt;
export const decrypt = defaultCrypto.decrypt;
export const sha256Hex = defaultCrypto.sha256Hex;
export const randomToken = defaultCrypto.randomToken;
export const randomCode = defaultCrypto.randomCode;
export const randomOtp = defaultCrypto.randomOtp;
export const timingSafeEqualHex = defaultCrypto.timingSafeEqualHex;
