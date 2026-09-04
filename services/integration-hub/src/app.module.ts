import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { HubClient } from './client';
import { HubController } from './hub.controller';
export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [HubController], providers: [HubClient] })
  class AppModule {}
  return AppModule;
}
