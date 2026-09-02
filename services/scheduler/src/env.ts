import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('scheduler'),
  PORT: z.coerce.number().default(5405),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_scheduler'),
  /** Tick interval of the firing loop; 0 disables the loop (tests, one-off tooling). */
  SCHEDULER_TICK_MS: z.coerce.number().int().min(0).default(15000),
  /** Zone new jobs are scheduled in when the caller does not name one. */
  SCHEDULER_TIMEZONE: z.string().default('Asia/Dubai'),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
