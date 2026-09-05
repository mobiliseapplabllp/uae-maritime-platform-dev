import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { NotificationsController } from './notifications.controller';
import { Dispatcher } from './dispatcher';
import { DeliveryService } from './delivery';
export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [NotificationsController], providers: [Dispatcher, DeliveryService] })
  class AppModule {}
  return AppModule;
}
