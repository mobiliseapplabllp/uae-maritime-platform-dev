import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({ SERVICE_NAME: z.string().default('audit-ledger'), PORT: z.coerce.number().default(5403), DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_audit'), AUDIT_RETENTION_DAYS: z.coerce.number().default(1825) });
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
