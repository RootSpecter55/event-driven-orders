import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { UnauthorizedError } from './errors';

/** Constant-time comparison, so response timing does not reveal how much of a key matched. */
export function keysMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Lets a request through only with `Authorization: Bearer <expectedKey>`. Used for admin routes. */
export function createApiKeyAuth(expectedKey: string): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token || !keysMatch(token, expectedKey)) return next(new UnauthorizedError());
    next();
  };
}
