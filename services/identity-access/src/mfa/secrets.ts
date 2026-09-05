import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Authenticator secrets rest encrypted with a key of the deployment's own: AES-256-GCM, a fresh nonce per value. */
export class SecretBox {
  private readonly key: Buffer;
  constructor(material: string) { this.key = createHash('sha256').update(`mfa:${material}`).digest(); }
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
}
export const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
