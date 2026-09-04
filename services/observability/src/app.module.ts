import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { Collector } from './collector';
import { PlatformController } from './platform.controller';
export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [PlatformController], providers: [Collector] })
  class AppModule {}
  return AppModule;
}
