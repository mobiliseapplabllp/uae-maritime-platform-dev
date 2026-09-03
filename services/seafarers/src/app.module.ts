import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { SeafarersController } from './seafarers.controller';
import { SeafarersConsumer } from './consumer';

export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [SeafarersController], providers: [SeafarersConsumer] })
  class AppModule {}
  return AppModule;
}
