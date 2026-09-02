import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('reporting'),
  PORT: z.coerce.number().default(5406),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_reporting'),
  WORKFLOW_URL: z.string().default('http://127.0.0.1:5407'),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
