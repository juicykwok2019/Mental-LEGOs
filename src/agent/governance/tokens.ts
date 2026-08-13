import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenHashMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOpaqueToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
