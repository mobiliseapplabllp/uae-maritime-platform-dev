import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Env } from './env';
import { serviceByName, urlOf } from '@maritime/contracts';
import { AiGatewayClient, KIT_ENV, KIT_POOL } from '@maritime/service-kit';
import { COMPLETION_CLIENT, LocalCompletionClient, type CompletionClient } from './completion';
import { IndexCache } from './assistant';

export const INDEX_CACHE = Symbol('INDEX_CACHE');
export const GATEWAY_CLIENT = Symbol('GATEWAY_CLIENT');

/* The two things the assistant is built out of, injected rather than reached for: the completion client the
 * configuration selects, and the retrieval index over this service's own corpus. Both are replaceable in a test
 * without touching a controller, which is the point. */
export const assistantProviders: Provider[] = [
  { provide: COMPLETION_CLIENT, useFactory: (env: Env): CompletionClient => new LocalCompletionClient(env.COMPLETION_PROFILE), inject: [KIT_ENV] },
  // the one path to the platform: every tool call and every completion goes through the tool gateway
  { provide: GATEWAY_CLIENT, useFactory: (env: Env) => new AiGatewayClient(env.AI_TOOL_GATEWAY_URL?.trim() || urlOf(serviceByName('ai-tool-gateway')!, process.env), env.SERVICE_TOKEN, env.AI_TOOL_GATEWAY_TIMEOUT_MS), inject: [KIT_ENV] },
  { provide: INDEX_CACHE, useFactory: (pool: Pool) => new IndexCache(pool), inject: [KIT_POOL] },
];
