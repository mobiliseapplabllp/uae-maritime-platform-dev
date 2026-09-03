import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { CompaniesController } from './companies.controller';
import { PortFacilitiesController } from './port-facilities.controller';
import { DirectoryController } from './directory.controller';
import { FacilitiesConsumer } from './consumer';

export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [CompaniesController, PortFacilitiesController, DirectoryController], providers: [FacilitiesConsumer] })
  class AppModule {}
  return AppModule;
}
