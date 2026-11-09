import { hash, verify } from '@node-rs/argon2';

// OWASP's Argon2id minimum: 19 MiB, two passes, one lane. The library defaults
// to Argon2id, creates a fresh 16-byte salt, and encodes salt and parameters.
const parameters = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, parameters);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
