import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({ SERVICE_NAME: z.string().default('notifications'), PORT: z.coerce.number().default(5404), DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_notifications') });
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
