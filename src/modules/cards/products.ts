import { z } from 'zod';
import { decimal, hash, payCurrency, record, type CardNetwork } from './domain.js';

export const productSchema = z.enum(['visa', 'mastercard_standard', 'visa_us', 'mastercard']);
export type CardProduct = z.infer<typeof productSchema>;
export const cardholderNameSchema = z.string().regex(/^[^\p{Cc}]*$/u, 'Cardholder name must not contain control characters.')
  .trim().max(100).transform((value) => value || null).nullable().optional();
export const profileVersionSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString()).optional();

const products = [
  { id: 'visa', name: 'Visa', network: 'visa', description: 'Virtual Visa for online payments.' },
  { id: 'mastercard_standard', name: 'Mastercard Standard', network: 'mastercard', description: 'Virtual Mastercard for online payments.' },
  { id: 'visa_us', name: 'Visa US', network: 'visa', description: 'Virtual Visa for US online services and subscriptions.' },
  { id: 'mastercard', name: 'Mastercard', network: 'mastercard', description: 'Virtual Mastercard with digital wallet support.' },
] as const;

export function productNetwork(product: string): string {
  return products.find(({ id }) => id === product)?.network ?? 'unknown';
}
export function productCatalog(cachedPricing: unknown) {
  const pricing = record(cachedPricing);
  return products.map((product) => ({ ...product, currency: 'USD' as const,
    issuePriceUsd: decimal(product.id === 'mastercard' ? pricing.mastercardIssuePriceUsd : pricing.issuePriceUsd),
  }));
}
export function nextProfileUpdatedAt(previous: Date | null, now = new Date()): Date {
  return new Date(Math.max(now.getTime(), previous ? previous.getTime() + 1 : 0));
}
export function issueRequestHash(scope: string, input: { product: CardProduct; network: CardNetwork; profileUpdatedAt?: string }): string {
  // Preserve the byte ordering and fields of legacy no-version issuance hashes.
  return hash(JSON.stringify({ providerScope: scope, product: input.product, network: input.network,
    ...(input.profileUpdatedAt !== undefined ? { profileUpdatedAt: profileVersionSchema.parse(input.profileUpdatedAt) } : {}),
  }));
}
export function issueRequestBody(input: { email: string; cardholderName: string | null; cardId: string; product: CardProduct; network: CardNetwork }): string {
  return JSON.stringify({ cardholder_email: input.email,
    ...(input.cardholderName ? { cardholder_alias: input.cardholderName } : {}),
    client_card_ref: input.cardId, card_type: input.product, pay_currency: payCurrency(input.network),
  });
}
