import { z } from 'zod';

/** Environment schema shared by every service; services extend it with their own keys. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().default('service'),
  PORT: z.coerce.number().int().positive().default(5400),
  DATABASE_URL: z.string().default('postgres://maritime:maritime@127.0.0.1:5432/maritime_dev'),
  NATS_URL: z.string().optional(),
  EVENT_BUS: z.enum(['nats', 'memory']).default('memory'),
  AUTH_MODE: z.enum(['local', 'keycloak']).default('local'),
  JWT_SECRET: z.string().min(8).default('development-only-secret-change-me'),
  JWT_ISSUER: z.string().default('maritime-platform'),
  JWT_EXPIRES_IN_SEC: z.coerce.number().default(12 * 3600),
  JWT_REFRESH_EXPIRES_IN_SEC: z.coerce.number().default(7 * 24 * 3600),
  KEYCLOAK_ISSUER: z.string().optional(),
  KEYCLOAK_JWKS_URI: z.string().optional(),
  KEYCLOAK_AUDIENCE: z.string().default('maritime-platform'),
  SERVICE_TOKEN: z.string().default('development-service-token'),
  IDENTITY_URL: z.string().default('http://127.0.0.1:5401'),
  MDM_URL: z.string().default('http://127.0.0.1:5402'),
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5300,http://127.0.0.1:5300'),
  JSON_LIMIT: z.string().default('2mb'),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(600),
  /* Cache tier. `memory` keeps a bounded per-process cache and needs nothing else running, which is what
   * development and a single-node deployment want. `redis` speaks the shared protocol, so the same setting
   * serves Redis and Valkey and the deployment decides which one is installed. */
  CACHE_DRIVER: z.enum(['memory', 'redis']).default('memory'),
  CACHE_URL: z.string().optional(),
  CACHE_PREFIX: z.string().default('maritime'),
  CACHE_TTL_SEC: z.coerce.number().int().positive().default(60),
  CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(5000),
  /* Search tier. `postgres` searches the read models directly; `opensearch` puts the engine in front of
   * them for matching and keeps PostgreSQL for authorisation and for the fallback when the engine is down. */
  SEARCH_DRIVER: z.enum(['postgres', 'opensearch']).default('postgres'),
  OPENSEARCH_URL: z.string().optional(),
  OPENSEARCH_PREFIX: z.string().default('maritime'),
  OPENSEARCH_USERNAME: z.string().optional(),
  OPENSEARCH_PASSWORD: z.string().optional(),
  OPENSEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
});
export type BaseEnv = z.infer<typeof baseEnvSchema>;

export const DEV_DEFAULTS = { JWT_SECRET: 'development-only-secret-change-me', SERVICE_TOKEN: 'development-service-token' } as const;

/** Production refuses to start on development defaults: no dev JWT secret, no dev service token, no local password auth. */
export function assertProductionSafe(env: Record<string, unknown>): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  // A boot-time configuration check against a published default, not an authentication decision: it
  // runs once, before any request exists, and the value it compares against is in this file.
  // nosemgrep: maritime-timing-unsafe-secret-comparison
  if (!env.JWT_SECRET || env.JWT_SECRET === DEV_DEFAULTS.JWT_SECRET || String(env.JWT_SECRET).length < 32) problems.push('JWT_SECRET must be set to a strong value (32+ characters)');
  if (!env.SERVICE_TOKEN || env.SERVICE_TOKEN === DEV_DEFAULTS.SERVICE_TOKEN || String(env.SERVICE_TOKEN).length < 32) problems.push('SERVICE_TOKEN must be set to a strong value (32+ characters)');
  if (env.AUTH_MODE !== 'keycloak') problems.push('AUTH_MODE must be keycloak in production');
  if (env.AUTH_MODE === 'keycloak' && !env.KEYCLOAK_ISSUER) problems.push('KEYCLOAK_ISSUER is required in production');
  if (typeof env.DATABASE_URL === 'string' && /maritime:maritime@/.test(env.DATABASE_URL)) problems.push('DATABASE_URL still uses the development credentials');
  return problems;
}

export function loadEnv<S extends z.ZodTypeAny>(schema: S, source: NodeJS.ProcessEnv = process.env): z.infer<S> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const problems = assertProductionSafe(parsed.data as Record<string, unknown>);
  if (problems.length) throw new Error(`Unsafe production configuration: ${problems.join('; ')}`);
  return parsed.data;
}
