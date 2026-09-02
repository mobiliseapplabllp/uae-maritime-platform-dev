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

export function buildAppModule(env: Env) {
  @Module({
    imports: [KitModule.forRoot({ env, principalResolver: { provide: PRINCIPAL_RESOLVER, useClass: LocalPrincipalResolver }, extraProviders: [UsersRepo] })],
    controllers: [AuthController, UsersController, RolesController, MetaController, InternalController],
    providers: [UsersRepo, LocalPrincipalResolver, AuthService],
  })
  class AppModule {}
  return AppModule;
}
