import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { ModelsController } from './models.controller';
import { ServingController } from './serving.controller';
import { DriftController } from './drift.controller';

/* The serving controller is registered before the models controller so `/ai-platform/infer/:key` and the
 * vision and speech routes are matched as their own paths and never swallowed by `/ai-platform/models/:key`. */
export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({
    imports: [KitModule.forRoot({ env, principalResolver })],
    controllers: [ServingController, DriftController, ModelsController],
  })
  class AppModule {}
  return AppModule;
}
