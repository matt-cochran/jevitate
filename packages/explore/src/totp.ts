import { createHmac } from "node:crypto";

/**
 * totp: RFC 6238 time-based one-time passwords, computed in-process (#72).
 *
 * The seed is a base32 secret (what an app shows at MFA enrolment). It is decoded and used here
 * only — never handed to a model, never written anywhere. HMAC-SHA1, 30-second steps, 6 digits:
 * the parameters every authenticator app defaults to.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export class TotpSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TotpSeedError";
  }
}

/** RFC 4648 base32 → bytes. Spaces, dashes and `=` padding are ignored; case-insensitive. */
export function decodeBase32(seed: string): Buffer {
  const clean = seed.replace(/[\s=-]/g, "").toUpperCase();
  if (clean === "") throw new TotpSeedError("TOTP seed is empty");
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = BASE32.indexOf(ch);
    // Never echo the seed (or any of it) in the error.
    if (v === -1) throw new TotpSeedError("TOTP seed is not base32");
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  /** Step length (s). Default 30. */
  readonly stepSeconds?: number;
  /** Code length. Default 6. */
  readonly digits?: number;
}

/** RFC 4226 HOTP of `counter` under the raw `key`. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The TOTP code for a base32 `seed` at `atMs` (epoch ms). */
export function totp(seed: string, atMs: number, opts: TotpOptions = {}): string {
  const step = opts.stepSeconds ?? 30;
  return hotp(decodeBase32(seed), Math.floor(atMs / 1000 / step), opts.digits ?? 6);
}
