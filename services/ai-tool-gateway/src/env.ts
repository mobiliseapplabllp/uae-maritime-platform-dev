import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';

export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('ai-tool-gateway'),
  PORT: z.coerce.number().default(5504),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_ai_tool_gateway'),
  /** How long an upstream tool call or an external inference may take before it is abandoned and recorded as such. */
  TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  INFERENCE_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  /** A local command that answers a prompt on stdout (the operator's own CLI on the gateway host); unset in deployment. */
  AI_CLI_COMMAND: z.string().trim().optional(),
  AI_CLI_ARGS: z.string().default('-p --output-format text'),
  AI_CLI_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** The hosted model providers' addresses. Which one answers, and with which model, is configuration in Settings → AI. */
  ANTHROPIC_BASE_URL: z.string().default('https://api.anthropic.com'),
  ANTHROPIC_VERSION: z.string().default('2023-06-01'),
  /** An adversarial-input score at or above this is refused before it reaches any model. */
  INJECTION_BLOCK_SCORE: z.coerce.number().min(0).max(1).default(0.8),
  /** Tokens per reply a hosted model may compose. */
  MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1200),
  /** How long an agent's token lasts when the gateway acts on its behalf. */
  AGENT_TOKEN_SEC: z.coerce.number().int().positive().default(120),
  /** Where the call log's window ends: quotas are counted over the trailing hour and day. */
  QUOTA_DEFAULT_HOURLY: z.coerce.number().int().positive().default(600),
  QUOTA_DEFAULT_DAILY: z.coerce.number().int().positive().default(5000),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
