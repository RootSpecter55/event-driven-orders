import { Redis } from 'ioredis';
import { getConfig } from './config';

/** A new connection. Blocking stream reads need a connection of their own. */
export function createRedisConnection(): Redis {
  const url = getConfig().REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set');
  return new Redis(url, {
    // Fail a command after one reconnect attempt instead of queueing it indefinitely.
    maxRetriesPerRequest: 1,
  });
}

// Singleton: one shared connection for non-blocking commands (publishing, acks).
let shared: Redis | undefined;
export function getRedis(): Redis {
  shared ??= createRedisConnection();
  return shared;
}
