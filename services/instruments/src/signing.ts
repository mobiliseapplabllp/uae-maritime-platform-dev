import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { KIT_ENV, KIT_POOL, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';

/* Digital signature over an issued instrument.
 *
 * The signature is taken over the register facts themselves and verification recomputes those facts from the stored
 * record, never from anything stored beside the signature: alter the holder's name, the expiry or the status after
 * issue and verification fails. Ed25519 — deterministic, short enough to print under a QR code, in Node's standard
 * library with nothing to audit. The key comes from a PKCS#8 PEM held in a key store, or (for demonstration and
 * development) is derived from a configured secret so the same public key survives restarts and reseeds. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export const DEFAULT_SIGNING_SECRET = 'maritime-registry-demonstration-key';

export interface SigningMaterial { privateKey: KeyObject; publicKey: KeyObject; keyId: string; pem: string }
export function loadSigningMaterial(opts: { pem?: string | null; secret?: string | null }): SigningMaterial {
  const privateKey = opts.pem
    ? createPrivateKey(opts.pem)
    : createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, createHash('sha256').update(opts.secret || DEFAULT_SIGNING_SECRET).digest()]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  // a short, stable identifier so a verifier can tell which key signed an old certificate after a rotation
  return { privateKey, publicKey, keyId: createHash('sha256').update(spki).digest('hex').slice(0, 16), pem: publicKey.export({ format: 'pem', type: 'spki' }).toString() };
}
export const materialFromEnv = (e: { CERT_SIGNING_KEY?: string; CERT_SIGNING_SECRET?: string; JWT_SECRET?: string }) => loadSigningMaterial({ pem: e.CERT_SIGNING_KEY, secret: e.CERT_SIGNING_SECRET || e.JWT_SECRET });

export interface SignedFacts { licenseNo: string; entityType: string; subjectKind?: string | null; subjectId?: string | null; entityName: string; issueDate: Date | string | null; expiryDate: Date | string | null }
export interface Signature { alg: 'Ed25519'; keyId: string; value: string; signedAt: string }
export interface Verification { signed: boolean; valid: boolean; keyId: string | null; signedAt: string | null; reason: string }
export const SIGNED_PAYLOAD = 'licenseNo|entityType|subjectKind|subjectRef|entityName|issueDate(ISO)|expiryDate(ISO)|ISSUED';

const isoOf = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : '');
/** The facts a certificate asserts, in a fixed order. Field order is part of the signature: reordering invalidates every signature ever issued, so it changes only alongside a key rotation. */
export const canonical = (doc: SignedFacts): string => [doc.licenseNo, doc.entityType, doc.subjectKind || 'COMPANY', doc.subjectId ? String(doc.subjectId) : '', doc.entityName, isoOf(doc.issueDate), isoOf(doc.expiryDate), 'ISSUED'].join('|');
export const signFacts = (m: SigningMaterial, doc: SignedFacts): Signature => ({ alg: 'Ed25519', keyId: m.keyId, value: edSign(null, Buffer.from(canonical(doc), 'utf8'), m.privateKey).toString('base64'), signedAt: new Date().toISOString() });
const check = (publicKey: KeyObject, doc: SignedFacts, value: string) => { try { return edVerify(null, Buffer.from(canonical(doc), 'utf8'), publicKey, Buffer.from(value, 'base64')); } catch { return false; } };

/** Holds the current key, registers it in the key history and verifies against the current or any retired key. */
@Injectable()
export class SigningService implements OnModuleInit {
  readonly material: SigningMaterial;
  private readonly history = new Map<string, KeyObject>();
  constructor(@Inject(KIT_ENV) env: Env, @Inject(KIT_POOL) private readonly pool: Pool) { this.material = materialFromEnv(env); }
  async onModuleInit() { await registerKey(this.pool, this.material); }
  publicKey() { return { alg: 'Ed25519' as const, keyId: this.material.keyId, publicKeyPem: this.material.pem }; }
  sign(doc: SignedFacts): Signature { return signFacts(this.material, doc); }
  /* Three outcomes are reported separately — unsigned, signed by a key this registry does not hold, and signed but altered since — because collapsing them into a boolean hides the one that means something is wrong. */
  async verify(doc: SignedFacts & { signature?: Signature | null }, client: Queryable = this.pool): Promise<Verification> {
    const sig = doc.signature;
    if (!sig || !sig.value) return { signed: false, valid: false, keyId: null, signedAt: null, reason: 'Not digitally signed' };
    const base = { signed: true, keyId: sig.keyId ?? null, signedAt: sig.signedAt ?? null };
    let key: KeyObject | null = null; let retired = false;
    if (!sig.keyId || sig.keyId === this.material.keyId) key = this.material.publicKey;
    else { key = await this.retiredKey(sig.keyId, client); retired = !!key; }
    if (!key) return { ...base, valid: false, reason: 'Signed by a key this registry does not hold' };
    const good = check(key, doc, sig.value);
    return { ...base, valid: good, reason: good ? (retired ? 'Signature matches the register entry (signed under an earlier registry key)' : 'Signature matches the register entry') : 'Signature does not match the register entry — the record has been altered since issue' };
  }
  private async retiredKey(keyId: string, client: Queryable): Promise<KeyObject | null> {
    const hit = this.history.get(keyId); if (hit) return hit;
    const r = await client.query<{ public_key_pem: string }>('SELECT public_key_pem FROM signing_keys WHERE key_id = $1', [keyId]);
    if (!r.rows[0]) return null;
    const k = createPublicKey(r.rows[0].public_key_pem); this.history.set(keyId, k); return k;
  }
}
/** Records the key in use and retires every other key — retired keys stay on file so older signatures remain verifiable. */
export async function registerKey(client: Queryable, m: SigningMaterial) {
  await client.query('INSERT INTO signing_keys(key_id, alg, public_key_pem, active) VALUES ($1, $2, $3, true) ON CONFLICT (key_id) DO UPDATE SET active = true, retired_at = NULL', [m.keyId, 'Ed25519', m.pem]);
  await client.query('UPDATE signing_keys SET active = false, retired_at = coalesce(retired_at, now()) WHERE key_id <> $1 AND active', [m.keyId]);
}
