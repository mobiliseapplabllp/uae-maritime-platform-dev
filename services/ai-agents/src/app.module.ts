import { Module, type Provider } from '@nestjs/common';
import { KitModule } from '@maritime/service-kit';
import type { Env } from './env';
import { AgentsController } from './agents.controller';
import { DecisionsController } from './decisions.controller';
import { MonitoringController } from './monitoring.controller';
import { CoverageController } from './coverage.controller';
import { AgentsConsumer } from './consumer';
import { InsightsController } from './insights.controller';
import { agentProviders } from './providers';

/* The decision, monitoring and insight controllers are registered before the roster so `/agents/decisions`,
 * `/agents/monitoring` and `/agents/insights` are matched as their own routes and never swallowed by `/agents/:agentId`. */
export function buildAppModule(env: Env, principalResolver?: Provider) {
  @Module({
    imports: [KitModule.forRoot({ env, principalResolver })],
    controllers: [DecisionsController, MonitoringController, CoverageController, InsightsController, AgentsController],
    providers: [...agentProviders, AgentsConsumer],
  })
  class AppModule {}
  return AppModule;
}
