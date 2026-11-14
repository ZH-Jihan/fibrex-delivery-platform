/**
 * Password hashing (SPEC: Argon2 password hashing; PLAN 3.2 `credential.hash`).
 *
 * Purpose: turn a password into a string that is safe to store, and check a password
 * against a stored string. Uses Argon2id from Node's own crypto module, so there is no
 * native add-on to build.
 *
 * Stored format is the standard PHC string, which carries its own parameters and salt:
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt base64>$<hash base64>
 * so the cost can be raised later without breaking existing hashes: verify() always uses
 * the parameters written in the hash it is checking.
 *
 * Cost: 19 MiB memory, 2 passes, 1 lane (the OWASP minimum for Argon2id).
 *
 * Depends on: node:crypto. Used by: kernel/auth/auth-service.ts (and the seed, commit 10).
 */
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

const MEMORY_KIB = 19_456;
const PASSES = 2;
const PARALLELISM = 1;
const SALT_BYTES = 16;
const TAG_BYTES = 32;

/** Upper bounds accepted from a stored hash, so a corrupted row cannot exhaust memory. */
const MAX_MEMORY_KIB = 1_048_576;
const MAX_PASSES = 16;
const MAX_PARALLELISM = 16;

const PHC =
  /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{11,86})\$([A-Za-z0-9+/]{22,86})$/;

function derive(
  password: string,
  salt: Buffer,
  memory: number,
  passes: number,
  parallelism: number,
  tagLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        memory,
        passes,
        parallelism,
        tagLength,
      },
      (err, key) => {
        if (err) reject(err);
        else resolve(Buffer.from(key));
      },
    );
  });
}

// PHC strings use base64 without padding.
const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, MEMORY_KIB, PASSES, PARALLELISM, TAG_BYTES);
  return `$argon2id$v=19$m=${String(MEMORY_KIB)},t=${String(PASSES)},p=${String(PARALLELISM)}$${b64(salt)}$${b64(tag)}`;
}

/** True when `password` matches `stored`. A malformed stored value never matches. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const m = PHC.exec(stored);
  if (m === null) return false;
  const memory = Number(m[1]);
  const passes = Number(m[2]);
  const parallelism = Number(m[3]);
  if (
    memory < 8 * parallelism ||
    memory > MAX_MEMORY_KIB ||
    passes < 1 ||
    passes > MAX_PASSES ||
    parallelism < 1 ||
    parallelism > MAX_PARALLELISM
  ) {
    return false;
  }
  const salt = Buffer.from(m[4] ?? '', 'base64');
  const expected = Buffer.from(m[5] ?? '', 'base64');
  if (salt.length < 8 || expected.length < 16) return false;
  const actual = await derive(password, salt, memory, passes, parallelism, expected.length);
  // Constant-time comparison: the time taken must not reveal how many bytes matched.
  return timingSafeEqual(actual, expected);
}

/**
 * A real hash of a random password nobody knows. When a sign-in names a user that does
 * not exist, the service verifies against this instead of answering at once, so the
 * response time does not reveal which usernames exist.
 */
let dummy: Promise<string> | undefined;
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(24).toString('base64'));
  await verifyPassword(await dummy, password);
}
