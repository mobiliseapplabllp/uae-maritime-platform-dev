import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Secrets at rest — authenticator seeds, counterpart credentials, webhook signing keys — are sealed with a key of
 * the deployment's own: AES-256-GCM, a fresh nonce per value, and the purpose folded into the key so a value sealed
 * for one use cannot be opened as another. The material is the deployment's secret (a dedicated key where one is
 * set, the token secret otherwise), never stored beside the values it protects.
 */
export class SecretBox {
  private readonly key: Buffer;
  constructor(material: string, purpose = 'secret') { this.key = createHash('sha256').update(`${purpose}:${material}`).digest(); }
  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
  }
  open(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split(':');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
  /** Seals every string value of a flat record; blanks are dropped rather than sealed. */
  sealAll(values: Record<string, string | undefined | null>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) if (typeof v === 'string' && v.length) out[k] = this.seal(v);
    return out;
  }
  openAll(sealed: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(sealed)) if (typeof v === 'string' && v.length) out[k] = this.open(v);
    return out;
  }
}

export const sha256hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
/** HMAC-SHA256 as lower-case hex — the signature a counterpart puts on an inbound delivery. */
export const hmacSha256Hex = (key: string, message: string | Buffer) => createHmac('sha256', key).update(message).digest('hex');
/** Constant-time comparison of two hex digests; a length mismatch is a mismatch, never an exception. */
export function digestsMatch(a: string, b: string): boolean {
  const x = Buffer.from(String(a || ''), 'utf8'); const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
/** A random secret a counterpart can be handed: 32 bytes, base64url. */
export const randomSecret = (bytes = 32) => randomBytes(bytes).toString('base64url');
