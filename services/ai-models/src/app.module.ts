import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { ModelsController } from './models.controller';
import { ServingController } from './serving.controller';
import { ModelsConsumer, RegistrySync } from './consumer';

export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [ServingController, ModelsController], providers: [ModelsConsumer, RegistrySync] })
  class AppModule {}
  return AppModule;
}
