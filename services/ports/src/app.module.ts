import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { BerthsController } from './berths.controller';
import { PortCallsController } from './calls.controller';
import { OpsController } from './ops.controller';
import { PortsConsumer } from './consumer';

export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [BerthsController, PortCallsController, OpsController], providers: [PortsConsumer] })
  class AppModule {}
  return AppModule;
}
