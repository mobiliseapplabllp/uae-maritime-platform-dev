import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { LookupsController } from './lookups.controller';
import { SettingsController } from './settings.controller';
import { CompaniesController } from './companies.controller';
import { VesselsController } from './vessels.controller';

export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [LookupsController, SettingsController, CompaniesController, VesselsController] })
  class AppModule {}
  return AppModule;
}
