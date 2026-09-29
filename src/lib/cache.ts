import { redis } from './redis.js';

const inFlight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  const redisKey = `c:${key}`;
  const value = await redis.get(redisKey);
  if (value !== null) {
    try {
      return JSON.parse(value) as T;
    } catch {
      await redis.del(redisKey);
    }
  }

  const pending = inFlight.get(redisKey);
  if (pending) return pending as Promise<T>;

  const load = (async () => {
    const result = await fn();
    const serialized = JSON.stringify(result);
    if (serialized !== undefined) await redis.set(redisKey, serialized, 'EX', ttlSec);
    return result;
  })();
  inFlight.set(redisKey, load);
  try {
    return await load;
  } finally {
    if (inFlight.get(redisKey) === load) inFlight.delete(redisKey);
  }
}

export async function invalidate(key: string): Promise<void> {
  await redis.del(`c:${key}`);
}
