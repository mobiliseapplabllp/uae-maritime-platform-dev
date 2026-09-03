import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { InspectionsController } from './inspections.controller';
import { TemplatesController } from './templates.controller';
import { InspectionConsumer } from './consumer';

export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [InspectionsController, TemplatesController], providers: [InspectionConsumer] })
  class AppModule {}
  return AppModule;
}
