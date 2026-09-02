import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { RulesController } from './rules.controller';
import { InternalRulesController } from './internal.controller';

export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [RulesController, InternalRulesController] })
  class AppModule {}
  return AppModule;
}
