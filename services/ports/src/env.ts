import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('ports'),
  PORT: z.coerce.number().default(5426),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_ports'),
  JURISDICTION: z.string().default('AE'),
  /** Voyage call numbers read `${VCN_PREFIX}-YYYY-NNNNN`, one atomic series per calendar year. */
  VCN_PREFIX: z.string().default('VCN'),
  /** Hours a berth is held from berthing when a call carries no ETD — the planning window conflict checks run against. */
  DEFAULT_STAY_HOURS: z.coerce.number().default(48),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
