import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { AuditController } from './audit.controller';
import { AuditConsumer } from './consumer';
export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [AuditController], providers: [AuditConsumer] })
  class AppModule {}
  return AppModule;
}
