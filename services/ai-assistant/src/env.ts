import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';

export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('ai-assistant'),
  PORT: z.coerce.number().default(5501),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_ai_assistant'),
  JURISDICTION: z.string().default('AE'),
  /**
   * How the assistant reads a record. `gateway` — the platform's mode — runs every tool through the tool gateway as
   * the person asking, with their own token, so the gateway's allow-lists, quotas and log apply and the service
   * checks the permission itself. `snapshot` reads this service's own read-model tables instead, for a deployment
   * that runs the assistant with no gateway reachable; it answers from what it has mirrored and nothing more.
   */
  TOOL_MODE: z.enum(['gateway', 'snapshot']).default('gateway'),
  AI_TOOL_GATEWAY_URL: z.string().optional(),
  AI_TOOL_GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /** The profile the platform composer reports when Settings → AI names none. A configuration key, never a vendor's identifier. */
  COMPLETION_PROFILE: z.string().default('platform-local'),
  /** How many passages an answer may be grounded in, and how far down the ranking is worth reading. */
  RETRIEVAL_TOP_K: z.coerce.number().int().positive().default(5),
  RETRIEVAL_MIN_SCORE: z.coerce.number().default(0.04),
  /**
   * How much of the blended score the trigram half may contribute. The word-level half is exact and leads;
   * the trigram half is what rescues a misspelling, a transliteration or a partial reference. 0 turns it off
   * and leaves pure tf-idf.
   */
  RETRIEVAL_DENSE_WEIGHT: z.coerce.number().min(0).max(1).default(0.25),
  /**
   * `auto` uses pgvector where the cluster has it; `memory` forces the in-process path, which is what a
   * machine without the extension runs and what a test comparing the two modes pins one side to.
   */
  RETRIEVAL_VECTOR_MODE: z.enum(['auto', 'memory']).default('auto'),
  /**
   * The corpus size at which retrieval moves its first pass into SQL. Below it, scoring every passage exactly
   * in process is both cheaper and exact, so that is what runs; above it, pgvector's index does the recall
   * and the exact vectors re-rank what it returns.
   */
  RETRIEVAL_ANN_MIN_DOCS: z.coerce.number().int().positive().default(2_000),
  /** How many turns of a conversation are carried forward as context. */
  HISTORY_TURNS: z.coerce.number().int().positive().default(8),
  /** An answer must cite something; when nothing scores, the assistant says so rather than inventing. */
  REQUIRE_CITATIONS: z.coerce.boolean().default(true),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
