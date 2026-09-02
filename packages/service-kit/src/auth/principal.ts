import type { TenancyScope } from '@maritime/contracts';
import type { JwtClaims } from './jwt';

/** The authenticated principal every service works with. Permissions are resolved at request time so matrix edits apply immediately. */
export interface Principal {
  id: string; sub: string; name: string; email: string; roleName?: string; perms: string[]; scope: TenancyScope; kind: 'user' | 'agent' | 'service'; active: boolean;
}
export interface PrincipalResolver { resolve(claims: JwtClaims, token: string): Promise<Principal | null> }
export const PRINCIPAL_RESOLVER = Symbol('PRINCIPAL_RESOLVER');
export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');
export interface TokenVerifier { verify(token: string): Promise<JwtClaims> }

/** Resolves principals through the identity service's internal endpoint, with a short cache and explicit invalidation. */
export class HttpPrincipalResolver implements PrincipalResolver {
  private cache = new Map<string, { at: number; value: Principal | null }>();
  constructor(private readonly identityUrl: string, private readonly serviceToken: string, private readonly ttlMs = 30_000) {}
  invalidate(sub?: string) { if (sub) this.cache.delete(sub); else this.cache.clear(); }
  async resolve(claims: JwtClaims): Promise<Principal | null> {
    const sub = String(claims.sub ?? '');
    if (!sub) return null;
    const hit = this.cache.get(sub);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const res = await fetch(`${this.identityUrl}/internal/principals/${encodeURIComponent(sub)}`, { headers: { 'x-service-token': this.serviceToken } });
    let value: Principal | null = null;
    if (res.ok) {
      const body = (await res.json()) as { success: boolean; data: Principal };
      value = body.success ? body.data : null;
    } else if (res.status !== 404) {
      throw new Error(`Principal resolution failed: ${res.status}`);
    }
    this.cache.set(sub, { at: Date.now(), value });
    return value;
  }
}

/** For tests and single-process setups: principals supplied directly. */
export class StaticPrincipalResolver implements PrincipalResolver {
  constructor(private readonly bySub: Record<string, Principal>) {}
  async resolve(claims: JwtClaims) { return this.bySub[String(claims.sub)] ?? null; }
}
