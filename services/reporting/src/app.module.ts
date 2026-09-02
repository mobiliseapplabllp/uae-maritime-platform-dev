import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { DashboardController } from './dashboard.controller';
import { StatsController } from './stats.controller';
import { SearchController } from './search.controller';
import { CardsController } from './cards.controller';
import { ReportsController } from './reports.controller';
import { ReadModelConsumer } from './consumer';
import { setProfile } from './queries';

export function buildAppModule(env: Env, principalResolver?: Provider) {
  setProfile(process.env.JURISDICTION ?? 'AE');
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [DashboardController, StatsController, SearchController, CardsController, ReportsController], providers: [ReadModelConsumer] })
  class AppModule {}
  return AppModule;
}
