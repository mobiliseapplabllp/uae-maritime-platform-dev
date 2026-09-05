import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('inspection'),
  PORT: z.coerce.number().default(5425),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_inspection'),
  JURISDICTION: z.string().default('AE'),
  /** Survey numbers read `${INS_PREFIX}-YYYY-NNN`, one atomic series per calendar year. */
  INS_PREFIX: z.string().default('INS'),
  /** Weighted compliance at or above this mark reads as satisfactory; the module setting overrides it. */
  PASS_SCORE_PCT: z.coerce.number().default(80),
  /** How long a finding gets to be rectified when the inspector does not set a date. */
  FINDING_DUE_DAYS: z.coerce.number().default(14),
  /** Notice numbers read `${NOTICE_PREFIX}-YYYY-NNNN`, one atomic series per calendar year. */
  NOTICE_PREFIX: z.string().default('NOT'),
  /** How recent the Smart Inspection agent's judgement of a ship must be to be carried onto a survey as its prediction; older, and the desk's own history rules predict instead. */
  PREDICTION_FRESH_DAYS: z.coerce.number().default(45),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
