import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../../config.js';
import { AppError } from '../../lib/errors.js';

export const providerScope = `izipay:${config.IZIPAY_MODE}:${config.IZIPAY_ACCOUNT_REF}`;
export const cardsEnabled = () => Boolean(config.CARDS_ENABLED && config.IZIPAY_API_KEY && config.IZIPAY_API_SECRET && config.CARD_DATA_ENC_KEY);
export const unavailable = () => new AppError('CARDS_UNAVAILABLE', 503, 'Cards are temporarily unavailable.');
export function requireCards() { if (!cardsEnabled()) throw unavailable(); }
function key() {
  if (!config.CARD_DATA_ENC_KEY) throw unavailable();
  return Buffer.from(config.CARD_DATA_ENC_KEY, 'hex');
}
export function encryptCardData(plain: string, context: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
export function decryptCardData(blob: string, context: string): string {
  const bytes = Buffer.from(blob, 'base64');
  try {
    if (bytes.length < 28 || bytes.toString('base64') !== blob) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  } catch { throw unavailable(); }
}
