import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { KIT_ENV, KIT_POOL } from '@maritime/service-kit';
import type { Env } from './env';
import { COMPLETION_CLIENT, createCompletionClient, type CompletionClient } from './completion';
import { IndexCache } from './assistant';

export const INDEX_CACHE = Symbol('INDEX_CACHE');

/* The two things the assistant is built out of, injected rather than reached for: the completion client the
 * configuration selects, and the retrieval index over this service's own corpus. Both are replaceable in a test
 * without touching a controller, which is the point. */
export const assistantProviders: Provider[] = [
  {
    provide: COMPLETION_CLIENT,
    useFactory: (env: Env): CompletionClient => createCompletionClient({
      mode: env.COMPLETION_MODE, profile: env.COMPLETION_PROFILE,
      gatewayUrl: env.MODEL_GATEWAY_URL, gatewayKey: env.MODEL_GATEWAY_KEY, timeoutMs: env.MODEL_GATEWAY_TIMEOUT_MS,
    }),
    inject: [KIT_ENV],
  },
  { provide: INDEX_CACHE, useFactory: (pool: Pool) => new IndexCache(pool), inject: [KIT_POOL] },
];
