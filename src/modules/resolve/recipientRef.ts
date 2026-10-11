import { phoneHmac } from '../../lib/crypto.js';

/** Opaque, sender-bound change detector; never exposes a wallet or link time. */
export function recipientRef(senderAddress: string, targetHmac: string, recipient: {
  address: string; phoneLinkedAt: Date | null;
}): string {
  if (!recipient.phoneLinkedAt) throw new Error('Linked recipient has no phone binding timestamp.');
  return phoneHmac(JSON.stringify(['recipient-ref-v1', senderAddress.toLowerCase(), targetHmac,
    recipient.address.toLowerCase(), recipient.phoneLinkedAt.toISOString()]));
}
