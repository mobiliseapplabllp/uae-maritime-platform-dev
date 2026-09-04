import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';

export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('ai-agents'),
  PORT: z.coerce.number().default(5502),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_ai_agents'),
  JURISDICTION: z.string().default('AE'),
  /** The runtime profile the agents are configured with. A configuration key, never a vendor's own identifier. */
  REASONING_PROFILE: z.string().default('platform-local'),
  REASONING_PROFILE_VERSION: z.string().default('2026-09'),
  /** Nothing acts below this however an agent is configured: the floor the ladder is built on. */
  ABSOLUTE_MIN_CONFIDENCE: z.coerce.number().default(0.5),
  /** How many subjects one on-demand run looks at, so a run stays bounded. */
  RUN_BATCH: z.coerce.number().int().positive().default(12),
  /** The rolling window drift and bias are measured over. */
  DRIFT_WINDOW_DAYS: z.coerce.number().int().positive().default(30),
  DRIFT_BUCKET_DAYS: z.coerce.number().int().positive().default(7),
  /** The service level the RFP sets for agreement between an agent and its reviewer, and for high-risk targeting. */
  SLA_AGREEMENT_PCT: z.coerce.number().default(85),
  SLA_MAX_FALSE_POSITIVE_PCT: z.coerce.number().default(15),
  /** A cohort with fewer decisions than this is reported but never called biased — the sample is too small to say. */
  BIAS_MIN_COHORT: z.coerce.number().int().positive().default(5),
  /** A cohort whose escalation or override rate differs from the population by more than this is flagged for audit. */
  BIAS_FLAG_DELTA_PCT: z.coerce.number().default(20),
  /** The window the agentic service rate is read over. Wide enough that a quarterly service still counts. */
  COVERAGE_WINDOW_DAYS: z.coerce.number().int().positive().default(90),
  /**
   * The day the adoption clock started. The directive fixes the rates and the interval, not the date the
   * interval runs from — that is the programme's, so the deployment states it rather than the code guessing.
   */
  COVERAGE_START: z.string().default('2026-01-01'),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
