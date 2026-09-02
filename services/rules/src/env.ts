import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('rules'),
  PORT: z.coerce.number().default(5408),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_rules'),
  EXPR_TIMEOUT_MS: z.coerce.number().default(250),
  EXPR_MAX_DEPTH: z.coerce.number().default(64),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
