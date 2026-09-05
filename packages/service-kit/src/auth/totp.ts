import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/* Time-based one-time passwords (RFC 6238 over RFC 4226): the second factor an authenticator app produces.
 *
 * Six digits, thirty-second steps, HMAC-SHA1 — the profile every authenticator app implements. Verification accepts
 * one step either side for clock drift, and reports the step it matched so the caller can refuse a code that has
 * already been used: a one-time password used twice is a replay, and the window that tolerates drift is exactly the
 * window a replay would exploit. */

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SEC = 30;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding, the encoding every authenticator app expects in a provisioning URI. */
export function base32Encode(buf: Buffer): string {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32 for the app and the URI. */
export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

export const totpStep = (at: Date | number = Date.now()): number => Math.floor((typeof at === 'number' ? at : at.getTime()) / 1000 / TOTP_STEP_SEC);

/** The code for one counter value. */
export function hotp(secretBase32: string, counter: number, digits = TOTP_DIGITS): string {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}
export const totpCode = (secretBase32: string, at: Date | number = Date.now()): string => hotp(secretBase32, totpStep(at));

/**
 * Verifies a code against the secret within ±`window` steps. Returns the matched step, or null.
 * `notBefore` is the last step already accepted for this secret: a code from that step or earlier is a replay and is
 * refused even though it is arithmetically valid.
 */
export function verifyTotp(secretBase32: string, code: string, opts: { at?: Date | number; window?: number; notBefore?: number | null } = {}): number | null {
  const given = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const centre = totpStep(opts.at ?? Date.now());
  const window = opts.window ?? 1;
  for (let d = -window; d <= window; d += 1) {
    const step = centre + d;
    if (opts.notBefore != null && step <= opts.notBefore) continue;
    const expected = hotp(secretBase32, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return step;
  }
  return null;
}

/** The provisioning URI an authenticator app scans (Google Authenticator key URI format). */
export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SEC}`;
}

/** Recovery codes: ten groups of eight, shown once; the caller stores only their hashes. */
export function generateRecoveryCodes(n = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const raw = base32Encode(randomBytes(5)).slice(0, 8).toLowerCase();
    out.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return out;
}
