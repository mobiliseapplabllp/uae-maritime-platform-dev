import { createHmac, createPublicKey, verify as cryptoVerify, timingSafeEqual, KeyObject } from 'node:crypto';

export interface JwtClaims { [k: string]: unknown; sub?: string; exp?: number; nbf?: number; iat?: number; iss?: string; aud?: string | string[]; typ?: string }
const b64u = (input: Buffer | string) => Buffer.from(input).toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

export function signHS256(payload: JwtClaims, secret: string, opts: { expiresInSec: number; issuer?: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: now, exp: now + opts.expiresInSec, ...(opts.issuer ? { iss: opts.issuer } : {}) }));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function decodeJwt(token: string): { header: Record<string, unknown>; payload: JwtClaims; signature: Buffer; signingInput: string } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [h, p, s] = parts;
  return {
    header: JSON.parse(fromB64u(h).toString('utf8')),
    payload: JSON.parse(fromB64u(p).toString('utf8')),
    signature: fromB64u(s),
    signingInput: `${h}.${p}`,
  };
}

/** Fetches and caches a JWKS document; keys are looked up by kid and refreshed once on a miss. */
export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  constructor(private readonly uri: string, private readonly ttlMs = 10 * 60 * 1000) {}
  private async refresh() {
    const res = await fetch(this.uri);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const doc = (await res.json()) as { keys: Array<Record<string, unknown> & { kid?: string }> };
    this.keys.clear();
    for (const jwk of doc.keys) if (jwk.kid) this.keys.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
    this.fetchedAt = Date.now();
  }
  async getKey(kid: string): Promise<KeyObject | undefined> {
    if (!this.keys.has(kid) || Date.now() - this.fetchedAt > this.ttlMs) await this.refresh();
    return this.keys.get(kid);
  }
}

export interface VerifyOptions { hsSecret?: string; jwks?: JwksCache; issuer?: string; audience?: string; clockToleranceSec?: number }

export async function verifyJwt(token: string, opts: VerifyOptions): Promise<JwtClaims> {
  const { header, payload, signature, signingInput } = decodeJwt(token);
  const alg = String(header.alg);
  if (alg === 'HS256') {
    if (!opts.hsSecret) throw new Error('HS256 token but no secret configured');
    const expected = createHmac('sha256', opts.hsSecret).update(signingInput).digest();
    if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) throw new Error('Invalid signature');
  } else if (alg === 'RS256' || alg === 'RS384' || alg === 'RS512') {
    if (!opts.jwks) throw new Error(`${alg} token but no JWKS configured`);
    const key = await opts.jwks.getKey(String(header.kid));
    if (!key) throw new Error('Unknown signing key');
    const digest = alg === 'RS256' ? 'RSA-SHA256' : alg === 'RS384' ? 'RSA-SHA384' : 'RSA-SHA512';
    if (!cryptoVerify(digest, Buffer.from(signingInput), key, signature)) throw new Error('Invalid signature');
  } else {
    throw new Error(`Unsupported algorithm ${alg}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const tol = opts.clockToleranceSec ?? 30;
  if (typeof payload.exp === 'number' && payload.exp + tol < now) throw new Error('Token expired');
  if (typeof payload.nbf === 'number' && payload.nbf - tol > now) throw new Error('Token not yet valid');
  if (opts.issuer && payload.iss !== opts.issuer) throw new Error('Wrong issuer');
  if (opts.audience) {
    const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    if (!aud.includes(opts.audience)) throw new Error('Wrong audience');
  }
  return payload;
}
