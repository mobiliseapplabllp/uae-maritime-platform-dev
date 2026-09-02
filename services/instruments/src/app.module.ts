import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { SigningService } from './signing';
import { InstrumentsConsumer } from './consumer';
import { LicencesController } from './licences.controller';
import { PublicController } from './public.controller';
import { InternalController } from './internal.controller';

export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [LicencesController, PublicController, InternalController], providers: [SigningService, InstrumentsConsumer] })
  class AppModule {}
  return AppModule;
}
