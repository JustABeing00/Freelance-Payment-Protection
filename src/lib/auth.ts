import { createHash, randomBytes } from "node:crypto";

/**
 * Auth helpers (foundation only; full session routes arrive in a later session).
 * Password hashing uses scrypt (Node stdlib, vetted) with per-user salt —
 * never custom crypto. argon2id remains an allowed swap (see security §2).
 */
const SALT_BYTES = 16;
const KEY_LEN = 64;

export interface PasswordHash {
  readonly algo: "scrypt";
  readonly saltHex: string;
  readonly hashHex: string;
  readonly params: { N: number; r: number; p: number; maxmem: number };
}

const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<PasswordHash> {
  if (password.length < 12) {
    throw new Error("Password must be at least 12 characters");
  }
  const salt = randomBytes(SALT_BYTES);
  const { scrypt } = await import("node:crypto");
  const derived: Buffer = await new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, PARAMS, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return {
    algo: "scrypt",
    saltHex: salt.toString("hex"),
    hashHex: derived.toString("hex"),
    params: PARAMS,
  };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const { scrypt, timingSafeEqual } = await import("node:crypto");
  const salt = Buffer.from(stored.saltHex, "hex");
  const expected = Buffer.from(stored.hashHex, "hex");
  const derived: Buffer = await new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, stored.params, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** Salted hash for IP/UA receipts (security §11: never store raw IPs in events). */
export function hashTelemetry(value: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${value}`, "utf8").digest("hex");
}
