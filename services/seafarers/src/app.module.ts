import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { SeafarersController } from './seafarers.controller';
import { MetController } from './met.controller';
import { CrewListsController } from './crewlists.controller';
import { SeafarersConsumer } from './consumer';

/* The desks with static paths (met, crew-lists, manning, foreign) are registered ahead of the register,
 * whose `:id` route would otherwise read "manning" as a seafarer. */
export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [MetController, CrewListsController, SeafarersController], providers: [SeafarersConsumer] })
  class AppModule {}
  return AppModule;
}
