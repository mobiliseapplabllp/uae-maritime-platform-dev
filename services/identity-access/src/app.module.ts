import { Module } from '@nestjs/common';
import { KitModule, PRINCIPAL_RESOLVER } from '@maritime/service-kit';
import type { Env } from './env';
import { UsersRepo } from './users/users.repo';
import { LocalPrincipalResolver } from './auth/local-principal.resolver';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { UsersController } from './users/users.controller';
import { RolesController } from './roles/roles.controller';
import { MetaController } from './meta/meta.controller';
import { InternalController } from './internal/internal.controller';
import { ReviewsController } from './reviews.controller';
import { PolicyService } from './policy';
import { MfaService } from './mfa/mfa.service';
import { IdentityConsumer } from './consumer';
import { SessionsRepo } from './auth/sessions.repo';

export function buildAppModule(env: Env) {
  @Module({
    imports: [KitModule.forRoot({ env, principalResolver: { provide: PRINCIPAL_RESOLVER, useClass: LocalPrincipalResolver }, extraProviders: [UsersRepo, SessionsRepo] })],
    controllers: [AuthController, UsersController, RolesController, MetaController, InternalController, ReviewsController],
    providers: [UsersRepo, SessionsRepo, LocalPrincipalResolver, AuthService, PolicyService, MfaService, IdentityConsumer],
  })
  class AppModule {}
  return AppModule;
}
