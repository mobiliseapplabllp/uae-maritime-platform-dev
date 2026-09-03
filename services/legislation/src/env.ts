import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('legislation'),
  PORT: z.coerce.number().default(5423),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_legislation'),
  JURISDICTION: z.string().default('AE'),
  /** Reference numbers the register allocates read `${prefix}-NN/YYYY`, one atomic series per type per calendar year. */
  REF_PAD: z.coerce.number().default(2),
  /** How long a recipient has to acknowledge a mandatory instrument when it does not set its own period. */
  ACK_DUE_DAYS: z.coerce.number().default(14),
  /** An instrument whose effective or expiry date falls inside this window is reported as coming up on the register dashboard. */
  HORIZON_DAYS: z.coerce.number().default(60),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
