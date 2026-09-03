import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { IncidentsController } from './incidents.controller';
import { TrackingController } from './tracking.controller';
import { MaritimeCentreConsumer } from './consumer';

export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [IncidentsController, TrackingController], providers: [MaritimeCentreConsumer] })
  class AppModule {}
  return AppModule;
}
