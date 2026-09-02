import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, UnauthorizedException, ForbiddenException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { hasPerm } from '@maritime/contracts';
import { PRINCIPAL_RESOLVER, TOKEN_VERIFIER, type Principal, type PrincipalResolver, type TokenVerifier } from './principal';
import { setActor } from '../context';

export const IS_PUBLIC = 'kit:public';
export const REQUIRED_PERMS = 'kit:perms';
export const SERVICE_ONLY = 'kit:service';
/** Route needs no session (health, login, public verification). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route requires one of the listed permissions (any match passes) — deny by default. */
export const RequirePerm = (...perms: string[]) => SetMetadata(REQUIRED_PERMS, perms);
/** Route is service-to-service only: authenticated by the shared service token, never by a user session. */
export const ServiceOnly = () => SetMetadata(SERVICE_ONLY, true);
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal | undefined => ctx.switchToHttp().getRequest<Request & { user?: Principal }>().user);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(PRINCIPAL_RESOLVER) private readonly resolver: PrincipalResolver,
    @Inject('KIT_SERVICE_TOKEN') private readonly serviceToken: string,
  ) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const req = ctx.switchToHttp().getRequest<Request & { user?: Principal }>();
    if (this.reflector.getAllAndOverride<boolean>(SERVICE_ONLY, targets)) {
      const token = req.header('x-service-token');
      if (!token || token !== this.serviceToken) throw new UnauthorizedException('Service token required');
      setActor({ id: 'service', name: 'service', kind: 'system' });
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const auth = req.header('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) throw new UnauthorizedException('Authentication required');
    let claims;
    try { claims = await this.verifier.verify(token); } catch (e) { throw new UnauthorizedException((e as Error).message || 'Invalid token'); }
    if (claims.typ === 'refresh') throw new UnauthorizedException('Refresh token cannot be used for access');
    const principal = await this.resolver.resolve(claims, token);
    if (!principal || !principal.active) throw new UnauthorizedException('Session no longer valid');
    req.user = principal;
    setActor({ id: principal.id, name: principal.name, email: principal.email, kind: principal.kind === 'agent' ? 'agent' : 'user' }, principal.scope);
    const perms = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMS, targets);
    if (perms && perms.length && !perms.some((p) => hasPerm(principal.perms, p))) {
      throw new ForbiddenException(`Forbidden: missing permission ${perms.join(' or ')}`);
    }
    return true;
  }
}
