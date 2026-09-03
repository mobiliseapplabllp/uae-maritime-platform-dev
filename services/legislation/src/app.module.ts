import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { LegislationController } from './legislation.controller';
import { NoticesController } from './notices.controller';
import { LegislationConsumer } from './consumer';

export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [LegislationController, NoticesController], providers: [LegislationConsumer] })
  class AppModule {}
  return AppModule;
}
