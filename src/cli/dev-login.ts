import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { config } from '../config.js';
import { chain } from '../lib/chain.js';
import { LOGIN_STATEMENT } from '../modules/auth/service.js';

if (config.NODE_ENV === 'production') {
  throw new Error('The dev login command is unavailable in production.');
}

const domain = config.SIWE_ALLOWED_DOMAINS[0];
const origin = config.CORS_ORIGINS[0];
if (!domain || !origin) throw new Error('SIWE_ALLOWED_DOMAINS and CORS_ORIGINS must be configured.');

const inputKey = process.argv[2];
const privateKey = inputKey
  ? (inputKey.startsWith('0x') ? inputKey : `0x${inputKey}`)
  : `0x${randomBytes(32).toString('hex')}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  throw new Error('Expected a 32-byte hex private key.');
}
const account = privateKeyToAccount(privateKey as `0x${string}`);
const baseUrl = 'http://localhost:8080';

async function jsonResponse(url: string, init?: RequestInit): Promise<{ response: Response; data: unknown }> {
  const response = await fetch(url, init);
  const data: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`Auth request failed with HTTP ${response.status}.`);
  }
  return { response, data };
}

const nonceResult = await jsonResponse(`${baseUrl}/v1/auth/nonce`);
const nonce = (nonceResult.data as { nonce?: unknown }).nonce;
if (typeof nonce !== 'string') throw new Error('Nonce response was invalid.');

const message = createSiweMessage({
  domain,
  address: account.address,
  uri: origin,
  version: '1',
  chainId: chain.id,
  nonce,
  issuedAt: new Date(),
  statement: LOGIN_STATEMENT,
});
const signature = await account.signMessage({ message });
const { response } = await jsonResponse(`${baseUrl}/v1/auth/verify`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-pingapp': '1',
    origin,
  },
  body: JSON.stringify({ message, signature }),
});
const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
if (!cookie?.startsWith('pa_session=')) throw new Error('Login did not return a session cookie.');

process.stdout.write(`address=${account.address}\nprivateKey=${privateKey}\ncurlCookieHeader=-H 'cookie: ${cookie}'\n`);
