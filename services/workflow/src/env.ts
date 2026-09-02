import { z } from 'zod';
import { DEFINITION_ENVIRONMENTS } from '@maritime/contracts';
import { baseEnvSchema, loadEnv } from '@maritime/service-kit';
export const envSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('workflow'),
  PORT: z.coerce.number().default(5407),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_workflow'),
  RULES_URL: z.string().default('http://127.0.0.1:5408'),
  /** `inline` evaluates guards and rule sets in-process over the cached rule sets; `http` asks the rules service and falls back to inline when it is unreachable. */
  RULES_MODE: z.enum(['inline', 'http']).default('inline'),
  /** The environment whose published definitions this instance runs requests against. */
  RUNTIME_ENVIRONMENT: z.enum(DEFINITION_ENVIRONMENTS).default('PROD'),
  JURISDICTION: z.string().default('AE'),
  EXPR_TIMEOUT_MS: z.coerce.number().default(250),
  EXPR_MAX_DEPTH: z.coerce.number().default(64),
});
export type Env = z.infer<typeof envSchema>;
export const env = () => loadEnv(envSchema);
