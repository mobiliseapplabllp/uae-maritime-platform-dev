import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';

export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('ai-assistant'),
  PORT: z.coerce.number().default(5501),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_ai_assistant'),
  JURISDICTION: z.string().default('AE'),
  /**
   * Which completion client answers. `local` is the deterministic composer that ships with the platform and is
   * what every test and every offline deployment runs on; `gateway` posts to a configured model gateway instead.
   * The profile is a configuration key the operator sets — this service never names a vendor or a model.
   */
  COMPLETION_MODE: z.enum(['local', 'gateway']).default('local'),
  COMPLETION_PROFILE: z.string().default('platform-local'),
  MODEL_GATEWAY_URL: z.string().optional(),
  MODEL_GATEWAY_KEY: z.string().optional(),
  MODEL_GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /** How many passages an answer may be grounded in, and how far down the ranking is worth reading. */
  RETRIEVAL_TOP_K: z.coerce.number().int().positive().default(5),
  RETRIEVAL_MIN_SCORE: z.coerce.number().default(0.04),
  /** How many turns of a conversation are carried forward as context. */
  HISTORY_TURNS: z.coerce.number().int().positive().default(8),
  /** An answer must cite something; when nothing scores, the assistant says so rather than inventing. */
  REQUIRE_CITATIONS: z.coerce.boolean().default(true),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
