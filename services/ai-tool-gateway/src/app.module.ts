import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { GatewayController } from './gateway.controller';
import { GATEWAY_FETCH, GatewayService, defaultFetch } from './gateway.service';

/* The fetch the engine uses for upstream calls and hosted providers is a provider of its own, so a test hands
 * in a stub and never opens a socket it did not mean to. An override given here replaces the default. */
export function buildAppModule(env: Env, principalResolver?: Provider, overrides: Provider[] = []) {
  @Module({
    imports: [KitModule.forRoot({ env, principalResolver })],
    controllers: [GatewayController],
    providers: [{ provide: GATEWAY_FETCH, useValue: defaultFetch }, GatewayService, ...overrides],
  })
  class AppModule {}
  return AppModule;
}
