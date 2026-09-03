import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { AgentsController } from './agents.controller';
import { DecisionsController } from './decisions.controller';
import { MonitoringController } from './monitoring.controller';
import { AgentsConsumer } from './consumer';

/* The decision and monitoring controllers are registered before the roster so `/agents/decisions` and
 * `/agents/monitoring` are matched as their own routes and never swallowed by `/agents/:agentId`. */
export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({
    imports: [KitModule.forRoot({ env, principalResolver })],
    controllers: [DecisionsController, MonitoringController, AgentsController],
    providers: [AgentsConsumer],
  })
  class AppModule {}
  return AppModule;
}
