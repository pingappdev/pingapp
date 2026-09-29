import { errors } from './errors.js';
import { logger } from './logger.js';

type FetchJsonOptions = {
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
  timeoutMs?: number;
};

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { method = 'GET', headers: extraHeaders, body, timeoutMs = 10_000 } = options;
  const headers = new Headers(extraHeaders);
  headers.set('user-agent', 'PingApp/1.0 (+https://pingapp)');
  headers.set('accept', 'application/json');
  if (body !== undefined) headers.set('content-type', 'application/json');
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'upstream HTTP request failed');
      throw errors.upstreamUnavailable();
    }
    return await response.json() as T;
  } catch (cause) {
    if (!(cause instanceof Error && cause.name === 'AppError')) {
      logger.warn({ errorType: cause instanceof Error ? cause.name : 'unknown' }, 'upstream HTTP request failed');
    }
    throw errors.upstreamUnavailable();
  }
}
