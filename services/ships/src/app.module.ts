import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { VesselsController } from './vessels.controller';
import { RegistrationsController } from './registrations.controller';
import { RegistryController } from './registry.controller';
import { RiskController } from './risk.controller';
import { ShipsConsumer } from './consumer';

export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [VesselsController, RegistrationsController, RegistryController, RiskController], providers: [ShipsConsumer] })
  class AppModule {}
  return AppModule;
}
