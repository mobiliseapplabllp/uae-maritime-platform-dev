import { Module, type Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { KitModule, KIT_LOGGER, KIT_POOL, type AppLogger } from '@maritime/service-kit';
import type { Env } from './env';
import { CatalogueController, StatsController } from './catalogue.controller';
import { DefinitionsController } from './definitions.controller';
import { RequestsController } from './requests.controller';
import { WorkflowConsumers } from './consumers';
import { RULES_CLIENT, WORKFLOW_ENGINE, WorkflowEngine } from './engine';
import { createRulesClient, type RulesClient } from './rules/client';

export function buildAppModule(env: Env, principalResolver?: Provider, overrides: { rules?: RulesClient; now?: () => Date } = {}) {
  const providers: Provider[] = [
    { provide: RULES_CLIENT, useFactory: (pool: Pool, log: AppLogger): RulesClient => overrides.rules ?? createRulesClient(env, pool, log), inject: [KIT_POOL, KIT_LOGGER] },
    { provide: WORKFLOW_ENGINE, useFactory: (rules: RulesClient) => new WorkflowEngine(rules, { source: env.SERVICE_NAME, jurisdiction: env.JURISDICTION, now: overrides.now }), inject: [RULES_CLIENT] },
    WorkflowConsumers,
  ];
  @Module({ imports: [KitModule.forRoot({ env, principalResolver })], controllers: [CatalogueController, DefinitionsController, RequestsController, StatsController], providers })
  class AppModule {}
  return AppModule;
}
