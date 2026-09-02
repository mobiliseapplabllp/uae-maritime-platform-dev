import { createHmac, timingSafeEqual } from 'node:crypto';

/** Signed download links: `<base>/<id>?exp=<unix seconds>&sig=<hmac-sha256(id|exp)>`. The signature binds the id and the expiry; nothing else is trusted from the query string. */
export const fileSignature = (secret: string, id: string, exp: number): string => createHmac('sha256', secret).update(`${id}|${exp}`).digest('hex');

export function verifyFileSignature(secret: string, id: string, exp: number, sig: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(sig) || !Number.isInteger(exp)) return false;
  const expected = Buffer.from(fileSignature(secret, id, exp), 'hex');
  const given = Buffer.from(sig, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function buildSignedUrl(base: string, secret: string, id: string, ttlSec: number, now = Date.now()): { url: string; expiresAt: string } {
  const exp = Math.floor(now / 1000) + ttlSec;
  return { url: `${base.replace(/\/+$/, '')}/${id}?exp=${exp}&sig=${fileSignature(secret, id, exp)}`, expiresAt: new Date(exp * 1000).toISOString() };
}
