import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('integration-hub'),
  PORT: z.coerce.number().default(5412),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_integration_hub'),
  /** Base delay for the retry backoff; each attempt doubles it and adds jitter. */
  HUB_RETRY_BASE_MS: z.coerce.number().int().min(10).default(250),
  /** Ceiling on the backoff, so a long outage does not push a retry hours out. */
  HUB_RETRY_MAX_MS: z.coerce.number().int().min(100).default(8000),
  /** Forces every adapter to stub regardless of its stored mode. Set in CI, where no counterpart exists. */
  HUB_FORCE_STUB: z.coerce.boolean().default(false),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
