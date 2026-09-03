import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { InvoicesController } from './invoices.controller';
import { TariffsController } from './tariffs.controller';
import { RevenueConsumer } from './consumer';

export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [InvoicesController, TariffsController], providers: [RevenueConsumer] })
  class AppModule {}
  return AppModule;
}
