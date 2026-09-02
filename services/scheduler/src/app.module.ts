import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { JobsController } from './jobs.controller';
import { Ticker } from './ticker';
export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [JobsController], providers: [Ticker] })
  class AppModule {}
  return AppModule;
}
