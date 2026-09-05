import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { LegislationController } from './legislation.controller';
import { NoticesController } from './notices.controller';
import { PublicPortalController } from './public.controller';
import { ImoWatchController } from './imo.controller';
import { LegislationConsumer } from './consumer';
import { IMO_FEED } from './feed.token';
import { HubSourceFeed, type SourceFeed } from './imo';

/** The IMO sources are read through the integration hub unless a test hands in its own feed. */
export function buildAppModule(env: Env, principalResolver?: Provider, feed?: SourceFeed) {
  const feedProvider: Provider = { provide: IMO_FEED, useValue: feed ?? new HubSourceFeed(env.INTEGRATION_HUB_URL, env.SERVICE_TOKEN, env.IMO_SOURCE_ADAPTER) };
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [PublicPortalController, ImoWatchController, LegislationController, NoticesController], providers: [LegislationConsumer, feedProvider] })
  class AppModule {}
  return AppModule;
}
